import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  createRedisClient,
  saleKeys,
  type SaleRedis,
} from '../../src/redis.js';
import { fixedWindow } from '../../src/sale/store.js';
import {
  AFTER_SALE,
  BEFORE_SALE,
  DURING_SALE,
  TEST_REDIS_URL,
  TEST_WINDOW,
  cleanup,
  connect,
  seed,
  testConfig,
} from '../helpers.js';

describe('API contract', () => {
  const config = testConfig();
  const keys = saleKeys(config.saleId);
  let redis: SaleRedis;
  let app: Express;

  beforeEach(async () => {
    redis = await connect();
    await seed(redis, config);
    app = buildApp({ config, redis, now: DURING_SALE, window: fixedWindow(TEST_WINDOW) });
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await redis.quit();
  });

  it('GET /api/sale/status reports active window, stock, and server time', async () => {
    const res = await request(app).get('/api/sale/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'active',
      startsAt: TEST_WINDOW.startsAt.toISOString(),
      endsAt: TEST_WINDOW.endsAt.toISOString(),
      serverTime: DURING_SALE().toISOString(),
      stockRemaining: config.initialStock,
      soldOut: false,
    });
  });

  it('GET /api/sale/status reports soldOut once stock is gone', async () => {
    await seed(redis, config, 0);
    const res = await request(app).get('/api/sale/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stockRemaining: 0, soldOut: true });
  });

  it('POST /api/purchase → 201 PURCHASED for a new user', async () => {
    const res = await request(app)
      .post('/api/purchase')
      .send({ userId: 'alice@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('PURCHASED');
  });

  it('POST /api/purchase → 200 ALREADY_PURCHASED on retry (idempotent)', async () => {
    await request(app).post('/api/purchase').send({ userId: 'alice' });
    const res = await request(app)
      .post('/api/purchase')
      .send({ userId: 'alice' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('ALREADY_PURCHASED');
    expect(await redis.get(keys.stock)).toBe(String(config.initialStock - 1));
  });

  it('normalizes case and whitespace: "  Alice@X.com " equals "alice@x.com"', async () => {
    await request(app)
      .post('/api/purchase')
      .send({ userId: '  Alice@X.com ' });
    const res = await request(app)
      .post('/api/purchase')
      .send({ userId: 'alice@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('ALREADY_PURCHASED');
  });

  it('POST /api/purchase → 409 SOLD_OUT once stock is exhausted', async () => {
    await seed(redis, config, 1);
    await request(app).post('/api/purchase').send({ userId: 'alice' });
    const res = await request(app)
      .post('/api/purchase')
      .send({ userId: 'bob' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOLD_OUT');
  });

  it('POST /api/purchase → 403 SALE_NOT_STARTED before the window', async () => {
    const early = buildApp({ config, redis, now: BEFORE_SALE, window: fixedWindow(TEST_WINDOW) });
    const res = await request(early)
      .post('/api/purchase')
      .send({ userId: 'alice' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SALE_NOT_STARTED');
    expect(await redis.get(keys.stock)).toBe(String(config.initialStock));
  });

  it('POST /api/purchase → 403 SALE_ENDED after the window', async () => {
    const late = buildApp({ config, redis, now: AFTER_SALE, window: fixedWindow(TEST_WINDOW) });
    const res = await request(late)
      .post('/api/purchase')
      .send({ userId: 'alice' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SALE_ENDED');
  });

  it.each([
    ['missing', {}],
    ['empty', { userId: '   ' }],
    ['bad characters', { userId: 'no spaces!' }],
    ['too long', { userId: 'x'.repeat(65) }],
    ['wrong type', { userId: 42 }],
  ])('POST /api/purchase → 400 VALIDATION_ERROR (%s)', async (_label, body) => {
    const res = await request(app).post('/api/purchase').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/purchase/:userId reflects purchase state', async () => {
    const before = await request(app).get('/api/purchase/alice');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ userId: 'alice', purchased: false });

    await request(app).post('/api/purchase').send({ userId: 'Alice' });

    const after = await request(app).get('/api/purchase/alice');
    expect(after.body).toEqual({ userId: 'alice', purchased: true });
  });

  it('unseeded sale → 503 SERVICE_UNAVAILABLE, never a phantom sale', async () => {
    await cleanup(redis, config);
    const res = await request(app)
      .post('/api/purchase')
      .send({ userId: 'alice' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('Redis unreachable → fast 503 on purchase and degraded /healthcheck', async () => {
    const dead = createRedisClient(TEST_REDIS_URL);
    dead.disconnect();
    const deadApp = buildApp({ config, redis: dead, now: DURING_SALE, window: fixedWindow(TEST_WINDOW) });

    const purchase = await request(deadApp)
      .post('/api/purchase')
      .send({ userId: 'alice' });
    expect(purchase.status).toBe(503);
    expect(purchase.body.code).toBe('SERVICE_UNAVAILABLE');

    const health = await request(deadApp).get('/healthcheck');
    expect(health.status).toBe(503);
    // No pool wired: degraded, and the fallback indicator reads off (v1 mode).
    expect(health.body).toMatchObject({ status: 'degraded', fallback: 'off' });

    const status = await request(deadApp).get('/api/sale/status');
    expect(status.status).toBe(503);
    expect(status.body.code).toBe('SERVICE_UNAVAILABLE');
  });
});
