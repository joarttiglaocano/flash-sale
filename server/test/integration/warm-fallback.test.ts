import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { getControl } from '../../src/allocator/control.js';
import { createRouter } from '../../src/allocator/router.js';
import { drainOnce, type DrainDeps } from '../../src/consumer/drain.js';
import type { AppConfig } from '../../src/config.js';
import { saleKeys, type SaleRedis } from '../../src/redis.js';
import { ensureWinsGroup, seedSale } from '../../src/sale/store.js';
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
 * Warm fallback. When the write-behind consumer has drained Redis's
 * wins into `orders`, the fail-forward reconciles `remaining = initial -
 * count(orders)`, so Postgres takes over from the TRUE count — total sold ==
 * stock, no re-sell across the failover. Contrast failover-money.test.ts,
 * where no consumer runs (worst-case lag) and the fallback re-sells fully.
 */
describe('warm fallback (reconcile at fail-forward)', () => {
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
    await ensureWinsGroup(redis, saleKeys(config.saleId));
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

  const drainAll = async () => {
    const deps: DrainDeps = {
      redis,
      pool,
      winsKey: saleKeys(config.saleId).wins,
      consumerName: config.consumer.name,
      batchSize: config.consumer.batchSize,
      blockMs: config.consumer.blockMs,
    };
    while ((await drainOnce(deps, '>')) > 0) {
      // drain until dry
    }
  };

  it('no oversell across the failover once the consumer has drained', async () => {
    const app = buildApp({
      config,
      redis,
      pool,
      now: DURING_SALE,
      router: createRouter({ pool, saleId: config.saleId, ttlMs: 0 }),
    });
    const wins = (rs: { status: number }[]) =>
      rs.filter((r) => r.status === 201).length;

    // Phase 1 — 10 buyers win on Redis.
    const p1 = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app).post('/api/purchase').send({ userId: `r${i}` }),
      ),
    );
    expect(wins(p1)).toBe(10);

    // The consumer drains those 10 wins into Postgres — the fallback is warm.
    await drainAll();
    expect(await redis.get(saleKeys(config.saleId).stock)).toBe('15');

    // Redis dies.
    redis.disconnect();

    // Phase 2 — 40 buyers fail forward to Postgres.
    const p2 = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(app).post('/api/purchase').send({ userId: `p${i}` }),
      ),
    );
    const pgWins = wins(p2);

    // The reconcile set remaining = 25 − 10 = 15, so Postgres sells exactly 15.
    expect(pgWins).toBe(15);
    // Total across both deciders == stock. No re-sell — the reconcile closed the gap.
    expect(10 + pgWins).toBe(STOCK);

    expect((await getControl(pool, config.saleId))?.allocator).toBe('postgres');
    const sale = await pool.query<{ remaining: number; n: number }>(
      `SELECT remaining, (SELECT count(*)::int FROM orders WHERE sale_id = $1) AS n
       FROM sales WHERE sale_id = $1`,
      [config.saleId],
    );
    expect(sale.rows[0]?.remaining).toBe(0);
    expect(sale.rows[0]?.n).toBe(25); // exactly stock, not 35+
  }, 30_000);
});
