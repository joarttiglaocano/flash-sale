import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getControl, setAllocator } from '../../src/allocator/control.js';
import { purchaseViaPostgres } from '../../src/allocator/postgres.js';
import { runFailback } from '../../src/recovery/failback.js';
import { saleKeys, type SaleKeys, type SaleRedis } from '../../src/redis.js';
import type { AppConfig } from '../../src/config.js';
import {
  cleanup,
  cleanupPg,
  connect,
  connectPg,
  seedPgSale,
  testConfig,
} from '../helpers.js';

/**
 * The manual failback. Simulates a sale that failed forward to
 * Postgres (some orders decided there) and runs runFailback to return control
 * to a fresh Redis, rebuilt from Postgres and fenced with the new epoch.
 */
describe('runFailback', () => {
  const pool = connectPg();
  let redis: SaleRedis;
  let config: AppConfig;
  let keys: SaleKeys;

  // Fast timings so the test doesn't sit through real cutover waits.
  const fastOpts = {
    ttlWaitMs: 10,
    settle: { stableMs: 20, pollMs: 10, timeoutMs: 500 },
    log: () => {},
  };

  beforeEach(async () => {
    redis = await connect();
    config = testConfig({ saleId: `test-${randomUUID()}`, initialStock: 5 });
    keys = saleKeys(config.saleId);
    await seedPgSale(pool, config.saleId, config.initialStock);
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await cleanupPg(pool, config.saleId);
    await redis.quit();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rebuilds Redis from Postgres, stamps the new epoch, and returns to redis', async () => {
    // Fail forward, then let Postgres decide two purchases.
    await setAllocator(pool, config.saleId, 'postgres');
    await purchaseViaPostgres(pool, config.saleId, 'alice', 1);
    await purchaseViaPostgres(pool, config.saleId, 'bob', 1);

    const result = await runFailback(redis, pool, keys, config.saleId, fastOpts);

    expect(result.epoch).toBe(2);

    const control = await getControl(pool, config.saleId);
    expect(control?.allocator).toBe('redis');
    expect(control?.epoch).toBe(2);

    // Redis is rebuilt from Postgres and fenced with the matching epoch.
    expect(await redis.scard(keys.purchasers)).toBe(2);
    expect(await redis.get(keys.stock)).toBe('3'); // 5 − 2
    expect(await redis.get(keys.epoch)).toBe('2');
    expect(await redis.sismember(keys.purchasers, 'alice')).toBe(1);
    expect(await redis.sismember(keys.purchasers, 'bob')).toBe(1);
  });

  it('refuses to fail back unless the sale is currently on postgres', async () => {
    // Fresh seed leaves control on redis.
    await expect(
      runFailback(redis, pool, keys, config.saleId, fastOpts),
    ).rejects.toThrow(/expected "postgres"/);
  });
});
