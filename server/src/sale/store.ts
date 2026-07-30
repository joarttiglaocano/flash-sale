import type { PgPool } from '../pg.js';
import { WINS_GROUP, type SaleKeys, type SaleRedis } from '../redis.js';
import type { SaleWindow } from './window.js';

export interface WindowProvider {
  /** Resolves the sale window, or null when the sale is not seeded. */
  get(): Promise<SaleWindow | null>;
}

export function fixedWindow(window: SaleWindow): WindowProvider {
  return { get: () => Promise.resolve(window) };
}

/**
 * Reads the window from the durable `sales` row instead of Redis — the
 * window source when Postgres is the decider, so the purchase path never
 * needs Redis at all.
 */
export function postgresWindowProvider(
  pool: PgPool,
  saleId: string,
): WindowProvider {
  return {
    async get() {
      const result = await pool.query<{ starts_at: Date; ends_at: Date }>(
        'SELECT starts_at, ends_at FROM sales WHERE sale_id = $1',
        [saleId],
      );
      const row = result.rows[0];
      return row ? { startsAt: row.starts_at, endsAt: row.ends_at } : null;
    },
  };
}

// Reads the window fresh on every call — one O(1) MGET. At this scale
// the API tier saturates long before Redis, so caching here would buy
// nothing and cost staleness after a reseed.
export function redisWindowProvider(
  redis: SaleRedis,
  keys: SaleKeys,
): WindowProvider {
  return {
    async get() {
      const [startsAt, endsAt] = await redis.mget(keys.startsAt, keys.endsAt);
      return startsAt && endsAt
        ? { startsAt: new Date(startsAt), endsAt: new Date(endsAt) }
        : null;
    },
  };
}

export interface SeedOptions {
  stock: number;
  startsAt: Date;
  endsAt: Date;
}

export async function seedSale(
  redis: SaleRedis,
  keys: SaleKeys,
  { stock, startsAt, endsAt }: SeedOptions,
): Promise<void> {
  await redis
    .multi()
    .set(keys.stock, String(stock))
    .set(keys.initialStock, String(stock))
    .set(keys.startsAt, startsAt.toISOString())
    .set(keys.endsAt, endsAt.toISOString())
    .del(keys.purchasers)
    .del(keys.wins)
    .exec();
}

/**
 * Creates the wins stream + consumer group if missing. Start id 0 (not $)
 * so wins XADDed before the consumer's first start are never skipped.
 */
export async function ensureWinsGroup(
  redis: SaleRedis,
  keys: SaleKeys,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', keys.wins, WINS_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!/BUSYGROUP/.test(err instanceof Error ? err.message : String(err))) {
      throw err;
    }
  }
}
