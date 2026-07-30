import { getControl, setAllocator } from '../allocator/control.js';
import type { PgPool } from '../pg.js';
import type { SaleKeys, SaleRedis } from '../redis.js';
import { rebuildDelta, rebuildSale, stampEpoch } from './rebuild.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface FailbackOptions {
  /** Wait after flipping to cutover so every instance is parking. Must exceed
   *  the deployed router cache TTL. */
  ttlWaitMs?: number;
  settle?: { stableMs?: number; pollMs?: number; timeoutMs?: number };
  log?: (msg: string) => void;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FailbackResult {
  epoch: number;
  bulkPurchasers: number;
  deltaAdded: number;
}

/**
 * The manual, human-run failback: return the decider from Postgres to a fresh
 * Redis with a sub-second park and no dropped requests. Abort-safe at every
 * step before the final flip — if it throws, flip control back to 'postgres'
 * and nothing is lost, because Postgres never stopped being able to decide.
 *
 * Precondition: the sale is currently failed forward (allocator = 'postgres').
 */
export async function runFailback(
  redis: SaleRedis,
  pool: PgPool,
  keys: SaleKeys,
  saleId: string,
  opts: FailbackOptions = {},
): Promise<FailbackResult> {
  const log = opts.log ?? (() => {});
  const delay = opts.delay ?? sleep;
  const now = opts.now ?? (() => Date.now());
  const ttlWaitMs = opts.ttlWaitMs ?? 1500;

  const control = await getControl(pool, saleId);
  if (!control) {
    throw new Error(`No control row for sale "${saleId}".`);
  }
  if (control.allocator !== 'postgres') {
    throw new Error(
      `Refusing to fail back: allocator is "${control.allocator}", expected ` +
        '"postgres". Failback runs only after a fail-forward.',
    );
  }
  const nextEpoch = control.epoch + 1;

  log('1/6 pre-stage — bulk rebuild of a fresh Redis from Postgres');
  const bulk = await rebuildSale(redis, pool, keys, saleId, { force: true });
  log(
    `     restored ${bulk.purchasers} purchasers, stock ${bulk.restoredStock}, ` +
      `watermark ${bulk.maxOrderId ?? 'none'}`,
  );

  log('2/6 flip to cutover — new purchases park');
  await setAllocator(pool, saleId, 'cutover');
  await delay(ttlWaitMs);

  log('3/6 wait for Postgres to stop taking new orders');
  await waitForNewOrdersToStop(pool, saleId, {
    now,
    delay,
    ...(opts.settle ?? {}),
  });

  log('4/6 delta catch-up');
  const delta = await rebuildDelta(redis, pool, keys, saleId, {
    sinceOrderId: bulk.maxOrderId,
  });
  log(`     added ${delta.added}, stock ${delta.restoredStock}`);

  log(`5/6 stamp Redis with epoch ${nextEpoch}`);
  await stampEpoch(redis, keys, nextEpoch);

  log('6/6 flip to redis — parked requests release to the fresh Redis');
  const final = await setAllocator(pool, saleId, 'redis');
  if (final.epoch !== nextEpoch) {
    log(`WARNING: expected epoch ${nextEpoch}, control now reads ${final.epoch}`);
  }

  return {
    epoch: final.epoch,
    bulkPurchasers: bulk.purchasers,
    deltaAdded: delta.added,
  };
}

interface SettleOptions {
  now: () => number;
  delay: (ms: number) => Promise<void>;
  stableMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Waits until Postgres stops taking new orders — the highest order id is
 * unchanged for `stableMs`. Once the cutover has parked new requests, only
 * in-flight Postgres transactions can still commit; this waits out that short
 * tail so the delta pass is exact. Returns (rather than throwing) on timeout —
 * the delta still catches up whatever landed.
 */
async function waitForNewOrdersToStop(
  pool: PgPool,
  saleId: string,
  { now, delay, stableMs = 500, pollMs = 200, timeoutMs = 10_000 }: SettleOptions,
): Promise<void> {
  const highestOrderId = async (): Promise<string | null> => {
    const result = await pool.query<{ max: string | null }>(
      'SELECT max(id) AS max FROM orders WHERE sale_id = $1',
      [saleId],
    );
    return result.rows[0]?.max ?? null;
  };

  const deadline = now() + timeoutMs;
  let lastSeenId = await highestOrderId();
  let unchangedSince = now();
  while (now() < deadline) {
    await delay(pollMs);
    const currentId = await highestOrderId();
    if (currentId === lastSeenId) {
      if (now() - unchangedSince >= stableMs) return;
    } else {
      lastSeenId = currentId;
      unchangedSince = now();
    }
  }
}
