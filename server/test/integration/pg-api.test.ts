import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { setAllocator } from '../../src/allocator/control.js';
import type { AppConfig } from '../../src/config.js';
import {
  cleanupPg,
  connect,
  connectPg,
  DURING_SALE,
  seedPgSale,
  testConfig,
} from '../helpers.js';
import type { SaleRedis } from '../../src/redis.js';

/**
 * The HTTP → Postgres path when the control flag routes to postgres. Same
 * money test as concurrency.test.ts, but every request goes through the real
 * Express stack and is decided in Postgres — no Redis in the decision path.
 * The window is read from the durable sales row too.
 */
describe('purchase API against the postgres allocator', () => {
  const pool = connectPg();
  let redis: SaleRedis;
  let config: AppConfig;

  beforeEach(async () => {
    // A live redis client satisfies buildApp, but the postgres decision
    // path never calls it — the money test only POSTs /api/purchase.
    redis = await connect();
    config = testConfig({ saleId: `test-${randomUUID()}`, initialStock: 25 });
    await seedPgSale(pool, config.saleId, config.initialStock);
    // Flip the control flag so the router decides purchases in Postgres.
    await setAllocator(pool, config.saleId, 'postgres');
  });

  afterEach(async () => {
    await cleanupPg(pool, config.saleId);
    await redis.quit();
  });

  afterAll(async () => {
    await pool.end();
  });

  const build = () => buildApp({ config, redis, pool, now: DURING_SALE });

  it('100 users × 5 simultaneous HTTP attempts → exactly 25 orders in postgres', async () => {
    const app = build();
    const USERS = 100;
    const ATTEMPTS = 5;

    const responses = await Promise.all(
      Array.from({ length: USERS * ATTEMPTS }, (_, i) =>
        request(app)
          .post('/api/purchase')
          .send({ userId: `user-${i % USERS}` }),
      ),
    );

    const byCode = new Map<string, number>();
    for (const res of responses) {
      expect([200, 201, 409]).toContain(res.status);
      const code = res.body.code as string;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    expect(byCode.get('PURCHASED')).toBe(25);
    expect(
      (byCode.get('ALREADY_PURCHASED') ?? 0) + (byCode.get('SOLD_OUT') ?? 0),
    ).toBe(USERS * ATTEMPTS - 25);

    const sale = await pool.query(
      'SELECT remaining FROM sales WHERE sale_id = $1',
      [config.saleId],
    );
    expect(sale.rows[0]?.remaining).toBe(0);

    const orders = await pool.query(
      'SELECT count(DISTINCT user_id)::int AS d FROM orders WHERE sale_id = $1',
      [config.saleId],
    );
    expect(orders.rows[0]?.d).toBe(25);
  }, 30_000);
});
