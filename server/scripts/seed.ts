import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import { awaitReady, createRedisClient, saleKeys } from '../src/redis.js';
import { provisionSale } from '../src/sale/provision.js';

const force = process.argv.includes('--force');
const config = loadConfig();
const redis = await awaitReady(createRedisClient(config.redisUrl));
const keys = saleKeys(config.saleId);

const existing = await redis.get(keys.stock);
if (existing !== null && !force) {
  console.error(
    `Refusing to reseed: ${keys.stock} already exists (${existing} remaining). ` +
      'Re-run with --force to reset stock, window, and purchasers.',
  );
  await redis.quit();
  process.exit(1);
}

// Explicit SALE_START/SALE_END win; otherwise the sale starts now and
// runs for SALE_DURATION_MINUTES — handy for demos.
const startsAt = config.explicitWindow?.startsAt ?? new Date();
const endsAt =
  config.explicitWindow?.endsAt ??
  new Date(startsAt.getTime() + config.saleDurationMs);

// Seeds Redis + Postgres and re-stamps Redis with the control epoch so the
// fence admits it — see provisionSale for why that stamp matters.
const pool = createPgPool(config.databaseUrl);
let epoch: number;
try {
  epoch = await provisionSale(redis, pool, config.saleId, {
    stock: config.initialStock,
    startsAt,
    endsAt,
  });
} finally {
  await pool.end();
}

console.log(
  `Seeded sale "${config.saleId}": stock=${config.initialStock}, ` +
    `window ${startsAt.toISOString()} → ${endsAt.toISOString()}, ` +
    `purchasers cleared, redis fenced at epoch ${epoch}.`,
);
console.log('Postgres: sale row upserted, previous orders cleared.');
if (force) {
  console.log(
    'NOTE: if the consumer is running, restart it — pending entries from ' +
      'the old stream could re-insert stale orders.',
  );
}
await redis.quit();
