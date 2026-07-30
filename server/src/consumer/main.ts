import { loadConfig } from '../config.js';
import { createPgPool } from '../pg.js';
import { awaitReady, createRedisClient, saleKeys } from '../redis.js';
import { ensureWinsGroup } from '../sale/store.js';
import { drainOnce, type DrainDeps } from './drain.js';

const config = loadConfig();
const redis = createRedisClient(config.redisUrl);
redis.on('error', (err) => console.error('[redis]', err.message));
await awaitReady(redis);

const pool = createPgPool(config.databaseUrl);
const keys = saleKeys(config.saleId);
const deps: DrainDeps = {
  redis,
  pool,
  winsKey: keys.wins,
  consumerName: config.consumer.name,
  batchSize: config.consumer.batchSize,
  blockMs: config.consumer.blockMs,
};

let running = true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shutdown(signal: string) {
  console.log(`[consumer] ${signal} received, finishing current batch…`);
  running = false;
  // The blocking read returns within blockMs; this is the backstop.
  setTimeout(() => process.exit(1), config.consumer.blockMs + 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await ensureWinsGroup(redis, keys);

// Pending entries first: wins this consumer read but never acked before a crash.
let recovered = 0;
for (;;) {
  const n = await drainOnce(deps, '0');
  if (n === 0) break;
  recovered += n;
}
if (recovered > 0) {
  console.log(`[consumer] recovered ${recovered} pending win(s) from a previous run`);
}

console.log(
  `[consumer] ${config.consumer.name} draining ${keys.wins} → postgres ` +
    `(batch ${config.consumer.batchSize}, block ${config.consumer.blockMs}ms)`,
);

while (running) {
  try {
    const n = await drainOnce(deps, '>');
    if (n > 0) console.log(`[consumer] persisted batch of ${n}`);
  } catch (err) {
    if (!running) break;
    // Redis or Postgres briefly down: the fail-fast client rejects
    // instantly, so back off instead of hot-looping.
    console.error('[consumer]', err instanceof Error ? err.message : err);
    await sleep(1_000);
  }
}

await pool.end();
await redis.quit().catch(() => redis.disconnect());
console.log('[consumer] stopped.');
