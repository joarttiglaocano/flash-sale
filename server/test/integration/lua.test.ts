import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saleKeys, type SaleRedis } from '../../src/redis.js';
import { cleanup, connect, seed, testConfig } from '../helpers.js';

describe('purchase.lua semantics', () => {
  const config = testConfig();
  const keys = saleKeys(config.saleId);
  let redis: SaleRedis;

  const purchase = (userId: string) =>
    redis.purchase(keys.stock, keys.purchasers, keys.wins, userId, config.saleId);

  beforeEach(async () => {
    redis = await connect();
    await seed(redis, config);
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await redis.quit();
  });

  it('returns PURCHASED and decrements stock exactly once', async () => {
    const outcome = await purchase('alice');
    expect(outcome).toBe('PURCHASED');
    expect(await redis.get(keys.stock)).toBe('4');
    expect(await redis.sismember(keys.purchasers, 'alice')).toBe(1);
  });

  it('is idempotent: same user again returns ALREADY_PURCHASED, stock unchanged', async () => {
    await purchase('alice');
    const second = await purchase('alice');
    expect(second).toBe('ALREADY_PURCHASED');
    expect(await redis.get(keys.stock)).toBe('4');
    expect(await redis.scard(keys.purchasers)).toBe(1);
  });

  it('sells the last item to exactly one of two users', async () => {
    await seed(redis, config, 1);
    const a = await purchase('alice');
    const b = await purchase('bob');
    expect([a, b].sort()).toEqual(['PURCHASED', 'SOLD_OUT']);
    expect(await redis.get(keys.stock)).toBe('0');
    expect(await redis.scard(keys.purchasers)).toBe(1);
  });

  it('never drives stock below zero', async () => {
    await seed(redis, config, 1);
    await purchase('alice');
    for (const user of ['bob', 'carol', 'dave']) {
      expect(await purchase(user)).toBe('SOLD_OUT');
    }
    expect(await redis.get(keys.stock)).toBe('0');
  });

  it('a prior purchaser still gets ALREADY_PURCHASED after sell-out', async () => {
    await seed(redis, config, 1);
    await purchase('alice');
    expect(await purchase('alice')).toBe('ALREADY_PURCHASED');
  });

  it('returns NOT_INITIALIZED when stock was never seeded', async () => {
    await cleanup(redis, config);
    expect(await purchase('alice')).toBe('NOT_INITIALIZED');
  });

  it('PURCHASED appends exactly one stream entry carrying userId and saleId', async () => {
    await purchase('alice');
    const entries = await redis.xrange(keys.wins, '-', '+');
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.[1]).toEqual(['userId', 'alice', 'saleId', config.saleId]);
  });

  it('ALREADY_PURCHASED appends nothing to the stream', async () => {
    await purchase('alice');
    await purchase('alice');
    expect(await redis.xlen(keys.wins)).toBe(1);
  });

  it('SOLD_OUT and NOT_INITIALIZED append nothing to the stream', async () => {
    await seed(redis, config, 1);
    await purchase('alice');
    expect(await purchase('bob')).toBe('SOLD_OUT');
    expect(await redis.xlen(keys.wins)).toBe(1);

    await cleanup(redis, config);
    expect(await purchase('carol')).toBe('NOT_INITIALIZED');
    expect(await redis.xlen(keys.wins)).toBe(0);
  });

  it('stream length always equals the purchasers set size', async () => {
    await seed(redis, config, 3);
    for (const user of ['alice', 'bob', 'alice', 'carol', 'dave', 'bob']) {
      await purchase(user);
    }
    // 3 stock, 4 distinct users → 3 wins, and only wins are journaled.
    expect(await redis.xlen(keys.wins)).toBe(await redis.scard(keys.purchasers));
    expect(await redis.xlen(keys.wins)).toBe(3);
  });
});
