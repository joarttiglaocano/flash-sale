import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { getControl, setAllocator } from '../../src/allocator/control.js';
import { createRouter } from '../../src/allocator/router.js';
import type { AppConfig } from '../../src/config.js';
import { saleKeys, type SaleRedis } from '../../src/redis.js';
import { seedSale } from '../../src/sale/store.js';
import { stampEpoch } from '../../src/recovery/rebuild.js';
import {
  cleanup,
  cleanupPg,
  connect,
  connectPg,
  DURING_SALE,
  seed,
  seedPgSale,
  testConfig,
  TEST_WINDOW,
} from '../helpers.js';

/**
 * Automatic fail-forward. When Redis is unusable, the API flips the
 * decider to Postgres and answers the same request there — the buyer never
 * sees the outage. Redis is killed with client.disconnect() (offline queue is
 * off, so commands throw immediately).
 */
describe('automatic fail-forward', () => {
  const pool = connectPg();
  let redis: SaleRedis;
  let config: AppConfig;

  beforeEach(async () => {
    redis = await connect();
    config = testConfig({ saleId: `test-${randomUUID()}`, initialStock: 5 });
    await seed(redis, config);
    await seedPgSale(pool, config.saleId, config.initialStock);
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

  const build = () =>
    buildApp({
      config,
      redis,
      pool,
      now: DURING_SALE,
      router: createRouter({ pool, saleId: config.saleId, ttlMs: 0 }),
    });

  it('a dead Redis fails the purchase forward to Postgres, transparently', async () => {
    const app = build();
    redis.disconnect(); // Redis is now gone

    const res = await request(app).post('/api/purchase').send({ userId: 'alice' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('PURCHASED');

    // The flag flipped to postgres, and the order is durable there.
    const control = await getControl(pool, config.saleId);
    expect(control?.allocator).toBe('postgres');

    const sale = await pool.query('SELECT remaining FROM sales WHERE sale_id = $1', [
      config.saleId,
    ]);
    expect(sale.rows[0]?.remaining).toBe(4);

    const order = await pool.query<{ user_id: string; stream_id: string }>(
      'SELECT user_id, stream_id FROM orders WHERE sale_id = $1',
      [config.saleId],
    );
    expect(order.rows[0]?.user_id).toBe('alice');
    expect(order.rows[0]?.stream_id).toBe(`pg:${control?.epoch}`);
  });

  it('once flipped, later requests decide in Postgres without touching Redis', async () => {
    const app = build();
    redis.disconnect();

    // First request trips the fail-forward.
    await request(app).post('/api/purchase').send({ userId: 'alice' });
    // Second request just works — Redis is never consulted again.
    const res = await request(app).post('/api/purchase').send({ userId: 'bob' });
    expect(res.status).toBe(201);

    const sale = await pool.query('SELECT remaining FROM sales WHERE sale_id = $1', [
      config.saleId,
    ]);
    expect(sale.rows[0]?.remaining).toBe(3);
  });

  it('GET /api/sale/status fails forward and serves from Postgres when Redis dies', async () => {
    const app = build();
    redis.disconnect(); // Redis is gone before any purchase POST

    // The buyer's page only polls status — this alone must recover the sale.
    const res = await request(app).get('/api/sale/status');
    expect(res.status).toBe(200);
    expect(res.body.stockRemaining).toBe(config.initialStock);

    // The read path flipped the decider, so the whole system is now on Postgres.
    const control = await getControl(pool, config.saleId);
    expect(control?.allocator).toBe('postgres');
  });

  it('a business SOLD_OUT never flips the flag (Redis stays primary)', async () => {
    // One unit, Redis alive: the second buyer is a real SOLD_OUT, not a failure.
    // seedSale also writes the window keys the redis path reads.
    await seedSale(redis, saleKeys(config.saleId), {
      stock: 1,
      startsAt: TEST_WINDOW.startsAt,
      endsAt: TEST_WINDOW.endsAt,
    });
    await pool.query(
      'UPDATE sales SET initial_stock = 1, remaining = 1 WHERE sale_id = $1',
      [config.saleId],
    );
    const app = build();

    const first = await request(app).post('/api/purchase').send({ userId: 'alice' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/purchase').send({ userId: 'bob' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SOLD_OUT');

    const control = await getControl(pool, config.saleId);
    expect(control?.allocator).toBe('redis'); // never flipped
  });

  describe('epoch fencing', () => {
    // Drive control to epoch 2 while keeping allocator = redis, as a completed
    // failback would (postgres → redis bumps the epoch).
    const bumpToEpoch2 = async () => {
      await setAllocator(pool, config.saleId, 'postgres');
      await setAllocator(pool, config.saleId, 'redis');
    };

    it('fences out a Redis whose epoch does not match — and fails forward', async () => {
      await seedSale(redis, saleKeys(config.saleId), {
        stock: 5,
        startsAt: TEST_WINDOW.startsAt,
        endsAt: TEST_WINDOW.endsAt,
      });
      await bumpToEpoch2(); // control epoch = 2, but Redis carries no stamp
      const app = build();

      const res = await request(app).post('/api/purchase').send({ userId: 'x' });

      // Stale generation rejected → failed forward to postgres.
      expect(res.status).toBe(201);
      const control = await getControl(pool, config.saleId);
      expect(control?.allocator).toBe('postgres');
      expect(Number(await redis.get(saleKeys(config.saleId).stock))).toBe(5); // redis untouched
    });

    it('admits a Redis whose epoch matches the control epoch', async () => {
      await seedSale(redis, saleKeys(config.saleId), {
        stock: 5,
        startsAt: TEST_WINDOW.startsAt,
        endsAt: TEST_WINDOW.endsAt,
      });
      await bumpToEpoch2();
      await stampEpoch(redis, saleKeys(config.saleId), 2); // fresh, correctly stamped
      const app = build();

      const res = await request(app).post('/api/purchase').send({ userId: 'y' });

      expect(res.status).toBe(201);
      expect(await redis.get(saleKeys(config.saleId).stock)).toBe('4'); // redis decided
      const control = await getControl(pool, config.saleId);
      expect(control?.allocator).toBe('redis'); // stayed on redis
    });
  });
});
