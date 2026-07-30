import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config.js';
import { drainOnce, type DrainDeps } from '../../src/consumer/drain.js';
import { rebuildSale } from '../../src/recovery/rebuild.js';
import { saleKeys, type SaleKeys, type SaleRedis } from '../../src/redis.js';
import { ensureWinsGroup, seedSale } from '../../src/sale/store.js';
import {
  cleanup,
  cleanupPg,
  connect,
  connectPg,
  TEST_WINDOW,
  testConfig,
} from '../helpers.js';

const pool = connectPg();

describe('rebuildSale — Redis reconstructed from Postgres', () => {
  let config: AppConfig;
  let keys: SaleKeys;
  let redis: SaleRedis;

  const purchase = (userId: string) =>
    redis.purchase(keys.stock, keys.purchasers, keys.wins, userId, config.saleId);

  /** Seed Redis + Postgres the way the seed script does. */
  const seedBoth = async (stock: number) => {
    await seedSale(redis, keys, {
      stock,
      startsAt: TEST_WINDOW.startsAt,
      endsAt: TEST_WINDOW.endsAt,
    });
    await ensureWinsGroup(redis, keys);
    await pool.query(
      `INSERT INTO sales (sale_id, initial_stock, remaining, starts_at, ends_at)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (sale_id) DO UPDATE SET initial_stock = EXCLUDED.initial_stock`,
      [config.saleId, stock, TEST_WINDOW.startsAt, TEST_WINDOW.endsAt],
    );
  };

  const drainAll = async () => {
    const deps: DrainDeps = {
      redis,
      pool,
      winsKey: keys.wins,
      consumerName: config.consumer.name,
      batchSize: config.consumer.batchSize,
      blockMs: config.consumer.blockMs,
    };
    while ((await drainOnce(deps, '>')) > 0) {
      // drain until dry
    }
  };

  /** Simulate a total Redis loss for this sale. */
  const wipeRedis = () => cleanup(redis, config);

  beforeEach(async () => {
    config = testConfig();
    keys = saleKeys(config.saleId);
    redis = await connect();
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await cleanupPg(pool, config.saleId);
    await redis.quit();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('reconstructs stock, purchasers, window, and an empty stream+group', async () => {
    await seedBoth(5);
    await purchase('alice');
    await purchase('bob');
    await drainAll();
    await wipeRedis();

    const result = await rebuildSale(redis, pool, keys, config.saleId);

    expect(result).toMatchObject({
      initialStock: 5,
      restoredStock: 3,
      purchasers: 2,
    });
    expect(await redis.get(keys.stock)).toBe('3');
    expect(await redis.get(keys.initialStock)).toBe('5');
    expect((await redis.smembers(keys.purchasers)).sort()).toEqual([
      'alice',
      'bob',
    ]);
    expect(await redis.get(keys.startsAt)).toBe(
      TEST_WINDOW.startsAt.toISOString(),
    );
    expect(await redis.get(keys.endsAt)).toBe(TEST_WINDOW.endsAt.toISOString());
    expect(await redis.xlen(keys.wins)).toBe(0);
  });

  it('the rebuilt state enforces the same invariants: winners stay deduped, stock sells to zero', async () => {
    await seedBoth(3);
    await purchase('alice');
    await purchase('bob');
    await drainAll();
    await wipeRedis();
    await rebuildSale(redis, pool, keys, config.saleId);

    // A pre-loss winner is still recognized.
    expect(await purchase('alice')).toBe('ALREADY_PURCHASED');
    // The remaining unit sells exactly once, then the sale is dry.
    expect(await purchase('carol')).toBe('PURCHASED');
    expect(await purchase('dave')).toBe('SOLD_OUT');
    expect(await redis.get(keys.stock)).toBe('0');
  });

  it('aborts when the durable store is inconsistent (orders exceed stock)', async () => {
    await seedBoth(1);
    // Fabricate a corrupt store: two orders against initial stock 1.
    await pool.query(
      `INSERT INTO orders (sale_id, user_id, stream_id)
       VALUES ($1, 'alice', 'x-1'), ($1, 'bob', 'x-2')`,
      [config.saleId],
    );
    await wipeRedis();

    await expect(
      rebuildSale(redis, pool, keys, config.saleId),
    ).rejects.toThrow(/exceed/);
    // The guard ran before any write: the sale stays closed (503, not oversell).
    expect(await redis.get(keys.stock)).toBeNull();
  });

});
