import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { getControl } from '../../src/allocator/control.js';
import { createRouter } from '../../src/allocator/router.js';
import type { AppConfig } from '../../src/config.js';
import { saleKeys, type SaleRedis } from '../../src/redis.js';
import { seedSale } from '../../src/sale/store.js';
import {
  cleanup,
  cleanupPg,
  connect,
  connectPg,
  DURING_SALE,
  seedPgSale,
  testConfig,
  TEST_WINDOW,
} from '../helpers.js';

/**
 * The failover money test — WORST CASE: no consumer runs, so none of Redis's
 * wins ever reach `orders`. Each decider is individually safe (25 each), but
 * the cross-tenure total re-sells fully (50 vs 25), because the warm
 * reconcile (`remaining = initial - count(orders)`) has an empty `orders` to
 * work from. This is the residual drain-lag gap at its maximum. Contrast
 * warm-fallback.test.ts, where the consumer has drained and the total is
 * exactly the stock.
 */
describe('failover money test', () => {
  const pool = connectPg();
  const STOCK = 25;
  let redis: SaleRedis;
  let config: AppConfig;

  beforeEach(async () => {
    redis = await connect();
    config = testConfig({ saleId: `test-${randomUUID()}`, initialStock: STOCK });
    await seedSale(redis, saleKeys(config.saleId), {
      stock: STOCK,
      startsAt: TEST_WINDOW.startsAt,
      endsAt: TEST_WINDOW.endsAt,
    });
    await seedPgSale(pool, config.saleId, STOCK);
  });

  afterEach(async () => {
    await cleanupPg(pool, config.saleId);
    try {
      await cleanup(redis, config);
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('each decider never oversells; a cold fallback re-sells across the switch', async () => {
    const app = buildApp({
      config,
      redis,
      pool,
      now: DURING_SALE,
      router: createRouter({ pool, saleId: config.saleId, ttlMs: 0 }),
    });
    const wins = (rs: { status: number }[]) =>
      rs.filter((r) => r.status === 201).length;

    // Phase 1 — 30 buyers race Redis for 25 units.
    const p1 = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        request(app).post('/api/purchase').send({ userId: `r${i}` }),
      ),
    );
    const redisWins = wins(p1);
    expect(redisWins).toBe(25); // Redis tenure: exactly its stock, no oversell

    // Redis dies.
    redis.disconnect();

    // Phase 2 — 40 buyers, all forced to fail forward to Postgres.
    const p2 = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(app).post('/api/purchase').send({ userId: `p${i}` }),
      ),
    );
    const pgWins = wins(p2);
    expect(pgWins).toBe(25); // Postgres tenure: exactly ITS stock, no oversell

    // The flag flipped, and Postgres's own books are internally consistent.
    expect((await getControl(pool, config.saleId))?.allocator).toBe('postgres');
    const orders = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders WHERE sale_id = $1',
      [config.saleId],
    );
    expect(orders.rows[0]?.n).toBe(25);
    const sale = await pool.query<{ remaining: number }>(
      'SELECT remaining FROM sales WHERE sale_id = $1',
      [config.saleId],
    );
    expect(sale.rows[0]?.remaining).toBe(0);

    // The documented gap: 25 + 25 = 50 items "sold" against 25 stock, because
    // the cold Postgres fallback never saw Redis's sales. The warm reconcile closes this.
    expect(redisWins + pgWins).toBe(50);
  }, 30_000);
});
