import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import { awaitReady, createRedisClient, saleKeys } from '../src/redis.js';
import { runFailback } from '../src/recovery/failback.js';

/**
 * Manual failback: return the decider from Postgres to a fresh Redis. Run this
 * only against a Redis you intend to promote — it is rebuilt from Postgres and
 * stamped with the new epoch. Preconditions: the sale is failed forward
 * (allocator = postgres) and this Redis is the one you want live.
 */
const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const redis = await awaitReady(createRedisClient(config.redisUrl));
const keys = saleKeys(config.saleId);

try {
  const result = await runFailback(redis, pool, keys, config.saleId, {
    log: (m) => console.log(m),
  });
  console.log(
    `\nFailback complete — allocator=redis, epoch=${result.epoch} ` +
      `(bulk ${result.bulkPurchasers} purchasers, delta +${result.deltaAdded}).`,
  );
} catch (err) {
  console.error(
    `\nFailback aborted: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error('Control is unchanged — the sale keeps deciding in Postgres.');
  process.exitCode = 1;
} finally {
  await redis.quit();
  await pool.end();
}
