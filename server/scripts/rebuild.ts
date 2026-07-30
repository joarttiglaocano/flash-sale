import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import { awaitReady, createRedisClient, saleKeys } from '../src/redis.js';
import { rebuildSale } from '../src/recovery/rebuild.js';

const force = process.argv.includes('--force');
const config = loadConfig();
const redis = await awaitReady(createRedisClient(config.redisUrl));
const pool = createPgPool(config.databaseUrl);
const keys = saleKeys(config.saleId);

try {
  const result = await rebuildSale(redis, pool, keys, config.saleId, { force });
  console.log(
    `Rebuilt sale "${config.saleId}" from Postgres: ` +
      `stock=${result.restoredStock}/${result.initialStock}, ` +
      `purchasers=${result.purchasers}, ` +
      `window ${result.startsAt.toISOString()} → ${result.endsAt.toISOString()}.`,
  );
  console.log('Wins stream reset to empty with a fresh consumer group.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
  await redis.quit();
}
