import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { saleKeys, type SaleRedis } from '../../src/redis.js';
import { fixedWindow } from '../../src/sale/store.js';
import {
  DURING_SALE,
  TEST_WINDOW,
  cleanup,
  connect,
  seed,
  testConfig,
} from '../helpers.js';

/**
 * The money test: N concurrent buyers race for M items with retries.
 * Proves no overselling and one-item-per-user under genuine concurrency.
 */
describe('concurrency correctness', () => {
  const STOCK = 25;
  const USERS = 100;
  const ATTEMPTS_PER_USER = 5;

  const config = testConfig({ initialStock: STOCK });
  const keys = saleKeys(config.saleId);
  let redis: SaleRedis;

  beforeEach(async () => {
    redis = await connect();
    await seed(redis, config);
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await redis.quit();
  });

  it(`${USERS} users × ${ATTEMPTS_PER_USER} simultaneous attempts → exactly ${STOCK} purchases`, async () => {
    const app = buildApp({ config, redis, now: DURING_SALE, window: fixedWindow(TEST_WINDOW) });

    const attempts = Array.from(
      { length: USERS * ATTEMPTS_PER_USER },
      (_, i) => ({
        userId: `user-${i % USERS}`,
      }),
    );

    const responses = await Promise.all(
      attempts.map((body) =>
        request(app).post('/api/purchase').send(body),
      ),
    );

    const byCode = new Map<string, number>();
    for (const res of responses) {
      const code = res.body.code as string;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      expect([200, 201, 409]).toContain(res.status);
    }

    expect(byCode.get('PURCHASED')).toBe(STOCK);
    expect(
      (byCode.get('ALREADY_PURCHASED') ?? 0) + (byCode.get('SOLD_OUT') ?? 0),
    ).toBe(USERS * ATTEMPTS_PER_USER - STOCK);

    expect(await redis.get(keys.stock)).toBe('0');
    expect(await redis.scard(keys.purchasers)).toBe(STOCK);

    const purchasers = await redis.smembers(keys.purchasers);
    expect(new Set(purchasers).size).toBe(STOCK);
  }, 30_000);

  it('stock is never negative even with more winners than items', async () => {
    const app = buildApp({ config, redis, now: DURING_SALE, window: fixedWindow(TEST_WINDOW) });
    await Promise.all(
      Array.from({ length: USERS }, (_, i) =>
        request(app).post('/api/purchase').send({ userId: `solo-${i}` }),
      ),
    );
    const remaining = Number(await redis.get(keys.stock));
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBe(0);
    expect(await redis.scard(keys.purchasers)).toBe(STOCK);
  }, 30_000);
});
