import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgPool } from './pg.js';
import { createRedisClient } from './redis.js';

const config = loadConfig();
const redis = createRedisClient(config.redisUrl);
redis.on('error', (err) => console.error('[redis]', err.message));

// With fallback on (the default) the pool drives per-request routing and is
// the fallback decider when Redis is unusable. FALLBACK=off runs the server
// Redis-only — no pool, no failover — a kill-switch for when Postgres itself
// is the thing misbehaving.
const pool = config.fallbackEnabled
  ? createPgPool(config.databaseUrl)
  : undefined;

const app = buildApp({ config, redis, ...(pool ? { pool } : {}) });

const server = app.listen(config.port, () => {
  console.log(
    `flash-sale server listening on :${config.port} ` +
      `(sale ${config.saleId}, stock ${config.initialStock}, ` +
      `${pool ? 'routing via control flag' : 'redis-only — fallback OFF'})`,
  );
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    Promise.all([
      redis.quit().catch(() => redis.disconnect()),
      pool?.end() ?? Promise.resolve(),
    ]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
