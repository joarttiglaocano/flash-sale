import type { PgPool } from '../pg.js';
import type { SaleKeys, SaleRedis } from '../redis.js';
import { ensureWinsGroup } from '../sale/store.js';

export interface RebuildResult {
  initialStock: number;
  restoredStock: number;
  purchasers: number;
  startsAt: Date;
  endsAt: Date;
  /** Highest orders.id included — the watermark a later delta pass starts from. */
  maxOrderId: number | null;
}

/**
 * Disaster recovery: reconstructs Redis sale state from Postgres after a
 * Redis loss. Preconditions: API and consumer stopped.
 *
 * Ordering is the safety property — the stock counter is written LAST.
 * If the rebuild crashes at any earlier step, the stock key is absent, the
 * Lua script returns NOT_INITIALIZED, and the API answers 503: a partial
 * rebuild can never oversell.
 */
export async function rebuildSale(
  redis: SaleRedis,
  pool: PgPool,
  keys: SaleKeys,
  saleId: string,
  { force = false }: { force?: boolean } = {},
): Promise<RebuildResult> {
  const sale = await pool.query<{
    initial_stock: number;
    starts_at: Date;
    ends_at: Date;
  }>(
    'SELECT initial_stock, starts_at, ends_at FROM sales WHERE sale_id = $1',
    [saleId],
  );
  const saleRow = sale.rows[0];
  if (!saleRow) {
    throw new Error(
      `Cannot rebuild sale "${saleId}": no sales row in Postgres. ` +
        'Was the sale ever seeded?',
    );
  }

  const orders = await pool.query<{ user_id: string; id: string }>(
    'SELECT user_id, id FROM orders WHERE sale_id = $1 ORDER BY id',
    [saleId],
  );
  const userIds = orders.rows.map((r) => r.user_id);
  const maxOrderId =
    orders.rows.length > 0
      ? Number(orders.rows[orders.rows.length - 1]?.id)
      : null;

  if (userIds.length > saleRow.initial_stock) {
    throw new Error(
      `Refusing to rebuild sale "${saleId}": ${userIds.length} orders exceed ` +
        `initial stock ${saleRow.initial_stock}. The durable store is ` +
        'inconsistent — investigate before touching Redis.',
    );
  }

  const existing = await redis.get(keys.stock);
  if (existing !== null && !force) {
    throw new Error(
      `Refusing to rebuild: ${keys.stock} already exists (${existing} ` +
        'remaining). Redis does not look lost — re-run with --force to ' +
        'overwrite it from Postgres anyway.',
    );
  }

  await redis
    .multi()
    .del(keys.stock, keys.purchasers, keys.wins)
    .set(keys.initialStock, String(saleRow.initial_stock))
    .set(keys.startsAt, saleRow.starts_at.toISOString())
    .set(keys.endsAt, saleRow.ends_at.toISOString())
    .exec();

  for (let i = 0; i < userIds.length; i += 1000) {
    await redis.sadd(keys.purchasers, ...userIds.slice(i, i + 1000));
  }
  await ensureWinsGroup(redis, keys);

  // LAST: only a complete rebuild ever re-opens the sale.
  const restoredStock = saleRow.initial_stock - userIds.length;
  await redis.set(keys.stock, String(restoredStock));

  return {
    initialStock: saleRow.initial_stock,
    restoredStock,
    purchasers: userIds.length,
    startsAt: saleRow.starts_at,
    endsAt: saleRow.ends_at,
    maxOrderId,
  };
}

export interface DeltaResult {
  added: number;
  restoredStock: number;
  maxOrderId: number | null;
}

/**
 * Failback catch-up: idempotently tops up a Redis that a prior bulk rebuild
 * already warmed, without wiping it. It SADDs only the purchasers whose order
 * id is greater than `sinceOrderId` (the bulk pass's watermark) and resets the
 * stock counter from the full order count — small because the bulk pass did
 * the heavy lifting, which is what keeps the cutover park sub-second.
 *
 * Stock is written LAST, mirroring the bulk rebuild. The failback only flips
 * the flag to `redis` after this returns, so a partial delta never goes live.
 */
export async function rebuildDelta(
  redis: SaleRedis,
  pool: PgPool,
  keys: SaleKeys,
  saleId: string,
  { sinceOrderId }: { sinceOrderId: number | null },
): Promise<DeltaResult> {
  const sale = await pool.query<{ initial_stock: number }>(
    'SELECT initial_stock FROM sales WHERE sale_id = $1',
    [saleId],
  );
  const initialStock = sale.rows[0]?.initial_stock;
  if (initialStock === undefined) {
    throw new Error(`Cannot delta-rebuild sale "${saleId}": no sales row.`);
  }

  const newOrders = await pool.query<{ user_id: string; id: string }>(
    'SELECT user_id, id FROM orders WHERE sale_id = $1 AND id > $2 ORDER BY id',
    [saleId, sinceOrderId ?? 0],
  );
  const newUserIds = newOrders.rows.map((order) => order.user_id);
  for (let batchStart = 0; batchStart < newUserIds.length; batchStart += 1000) {
    await redis.sadd(
      keys.purchasers,
      ...newUserIds.slice(batchStart, batchStart + 1000),
    );
  }

  const totals = await pool.query<{ count: string; max: string | null }>(
    'SELECT count(*)::int AS count, max(id) AS max FROM orders WHERE sale_id = $1',
    [saleId],
  );
  const orderCount = Number(totals.rows[0]?.count ?? 0);
  const restoredStock = initialStock - orderCount;

  // LAST: only a complete top-up sets the live stock counter.
  await redis.set(keys.stock, String(restoredStock));

  return {
    added: newUserIds.length,
    restoredStock,
    maxOrderId: totals.rows[0]?.max != null ? Number(totals.rows[0].max) : null,
  };
}

/**
 * Stamps the control epoch into Redis as the fencing token. A freshly rebuilt
 * Redis carries the current epoch; an API instance that finds a mismatch (a
 * stale, never-rebuilt Redis) refuses it and fails forward.
 */
export async function stampEpoch(
  redis: SaleRedis,
  keys: SaleKeys,
  epoch: number,
): Promise<void> {
  await redis.set(keys.epoch, String(epoch));
}
