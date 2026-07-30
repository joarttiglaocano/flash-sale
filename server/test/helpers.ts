import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../src/config.js';
import { createPgPool, type PgPool } from '../src/pg.js';
import {
  awaitReady,
  createRedisClient,
  saleKeys,
  type SaleRedis,
} from '../src/redis.js';
import type { SaleWindow } from '../src/sale/window.js';

export const TEST_REDIS_URL =
  process.env.REDIS_URL ?? 'redis://localhost:6379';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://flash:flash@localhost:5432/flashsale';

export const TEST_WINDOW: SaleWindow = {
  startsAt: new Date('2026-07-24T10:00:00Z'),
  endsAt: new Date('2026-07-24T12:00:00Z'),
};

export const DURING_SALE = () => new Date('2026-07-24T11:00:00Z');
export const BEFORE_SALE = () => new Date('2026-07-24T09:00:00Z');
export const AFTER_SALE = () => new Date('2026-07-24T13:00:00Z');

/** Each test run gets its own key namespace so parallel runs never collide. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    redisUrl: TEST_REDIS_URL,
    saleId: `test-${randomUUID()}`,
    initialStock: 5,
    saleDurationMs: 10 * 60_000,
    explicitWindow: null,
    databaseUrl: TEST_DATABASE_URL,
    fallbackEnabled: true,
    // Small blockMs so consumer tests never sit in a 5s blocking read.
    consumer: { name: 'consumer-test', batchSize: 100, blockMs: 100 },
    ...overrides,
  };
}

export async function seed(
  redis: SaleRedis,
  config: AppConfig,
  stock = config.initialStock,
): Promise<void> {
  const keys = saleKeys(config.saleId);
  await redis
    .multi()
    .set(keys.stock, String(stock))
    .set(keys.initialStock, String(stock))
    .del(keys.purchasers)
    .del(keys.wins)
    .exec();
}

export async function cleanup(
  redis: SaleRedis,
  config: AppConfig,
): Promise<void> {
  const keys = saleKeys(config.saleId);
  await redis.del(
    keys.stock,
    keys.initialStock,
    keys.purchasers,
    keys.startsAt,
    keys.endsAt,
    keys.wins,
    keys.epoch,
  );
}

/**
 * The client fails fast (enableOfflineQueue: false), so tests must wait
 * for the connection to be ready before issuing commands.
 */
export function connect(): Promise<SaleRedis> {
  return awaitReady(createRedisClient(TEST_REDIS_URL));
}

/** One pool per test file; call pool.end() in afterAll or vitest hangs. */
export function connectPg(): PgPool {
  return createPgPool(TEST_DATABASE_URL);
}

export async function cleanupPg(pool: PgPool, saleId: string): Promise<void> {
  await pool.query('DELETE FROM orders WHERE sale_id = $1', [saleId]);
  await pool.query('DELETE FROM control WHERE sale_id = $1', [saleId]);
  await pool.query('DELETE FROM sales WHERE sale_id = $1', [saleId]);
}

/**
 * Seeds the Postgres side only (sales + control rows), the way the seed
 * script does — for tests where Postgres is the sole decider and Redis
 * is never touched.
 */
export async function seedPgSale(
  pool: PgPool,
  saleId: string,
  stock: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO sales (sale_id, initial_stock, remaining, starts_at, ends_at)
     VALUES ($1, $2, $2, $3, $4)`,
    [saleId, stock, TEST_WINDOW.startsAt, TEST_WINDOW.endsAt],
  );
  await pool.query('INSERT INTO control (sale_id) VALUES ($1)', [saleId]);
}
