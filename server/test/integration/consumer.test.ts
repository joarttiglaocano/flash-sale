import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  drainOnce,
  persistBatch,
  readBatch,
  type DrainDeps,
} from '../../src/consumer/drain.js';
import { saleKeys, WINS_GROUP, type SaleKeys, type SaleRedis } from '../../src/redis.js';
import { ensureWinsGroup } from '../../src/sale/store.js';
import type { AppConfig } from '../../src/config.js';
import {
  cleanup,
  cleanupPg,
  connect,
  connectPg,
  seed,
  testConfig,
} from '../helpers.js';

const pool = connectPg();

describe('write-behind consumer', () => {
  let config: AppConfig;
  let keys: SaleKeys;
  let redis: SaleRedis;
  let deps: DrainDeps;

  const purchase = (userId: string) =>
    redis.purchase(keys.stock, keys.purchasers, keys.wins, userId, config.saleId);

  const orderUserIds = async () => {
    const result = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM orders WHERE sale_id = $1 ORDER BY user_id',
      [config.saleId],
    );
    return result.rows.map((r) => r.user_id);
  };

  const pendingCount = async () => {
    const summary = (await redis.xpending(keys.wins, WINS_GROUP)) as [
      number,
      ...unknown[],
    ];
    return summary[0];
  };

  beforeEach(async () => {
    config = testConfig();
    keys = saleKeys(config.saleId);
    redis = await connect();
    deps = {
      redis,
      pool,
      winsKey: keys.wins,
      consumerName: config.consumer.name,
      batchSize: config.consumer.batchSize,
      blockMs: config.consumer.blockMs,
    };
    await seed(redis, config);
    await ensureWinsGroup(redis, keys);
  });

  afterEach(async () => {
    await cleanup(redis, config);
    await cleanupPg(pool, config.saleId);
    await redis.quit();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('drains stream entries into orders rows and acks them', async () => {
    await purchase('alice');
    await purchase('bob');
    await purchase('carol');

    expect(await drainOnce(deps, '>')).toBe(3);
    expect(await orderUserIds()).toEqual(['alice', 'bob', 'carol']);
    expect(await pendingCount()).toBe(0);
    // Nothing left to read.
    expect(await drainOnce(deps, '>')).toBe(0);
  });

  it('crash after insert but before ack: redelivery inserts no duplicates', async () => {
    await purchase('alice');
    await purchase('bob');

    // Simulate the classic gap: read + insert commit, then "crash" (no ack).
    const entries = await readBatch(deps, '>');
    expect(entries).toHaveLength(2);
    expect(await persistBatch(pool, entries)).toBe(2);
    expect(await pendingCount()).toBe(2);

    // Restart: the pending entries are re-read first and replayed.
    expect(await drainOnce(deps, '0')).toBe(2);
    expect(await orderUserIds()).toEqual(['alice', 'bob']);
    expect(await pendingCount()).toBe(0);
  });

  it('recovers entries read before a crash even when nothing was inserted', async () => {
    await purchase('alice');

    // Read (marks the entry pending), then "crash" before the insert.
    expect(await readBatch(deps, '>')).toHaveLength(1);
    expect(await orderUserIds()).toEqual([]);

    expect(await drainOnce(deps, '0')).toBe(1);
    expect(await orderUserIds()).toEqual(['alice']);
    expect(await pendingCount()).toBe(0);
  });

});
