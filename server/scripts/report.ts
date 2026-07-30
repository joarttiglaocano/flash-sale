import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import {
  awaitReady,
  createRedisClient,
  saleKeys,
  type SaleRedis,
} from '../src/redis.js';

/**
 * Post-run winners/losers report. Writes k6/report.csv (one row per contender:
 * userId, outcome, decided_by) and k6/report.json (the same, plus per-store
 * counts), and prints a summary table.
 *
 * Losers are never stored anywhere — only winners are — so the field of
 * contenders is rebuilt from the load's deterministic id scheme and the winners
 * subtracted. Defaults match the k6 stress script (k6-user-0 ..); override for a
 * custom load: TOTAL_USERS=10000 USER_TEMPLATE='flap-{i}@demo.com'.
 *
 * Postgres is the authoritative source of winners here: after a failover it
 * holds everyone, and it is up whenever the sale is. The Redis purchaser set is
 * read best-effort — it fills the small window of wins not yet drained during
 * normal operation, but the report still works with Redis down (the whole point
 * of the system), noting it as unavailable.
 */
const totalUsers = Number(process.env.TOTAL_USERS ?? 10000);
const template = process.env.USER_TEMPLATE ?? 'k6-user-{i}';
const idFor = (i: number) =>
  template.replace('{i}', String(i)).trim().toLowerCase();

const k6Dir = ['../k6', 'k6']
  .map((rel) => resolve(process.cwd(), rel))
  .find((dir) => existsSync(dir));
if (!k6Dir) {
  throw new Error(
    'Could not find the k6 directory to write the report into — run from the repo root.',
  );
}

const config = loadConfig();
const keys = saleKeys(config.saleId);
const pool = createPgPool(config.databaseUrl);

// Postgres is authoritative and always up when the sale is.
const sale = await pool.query<{ initial_stock: number }>(
  'SELECT initial_stock FROM sales WHERE sale_id = $1',
  [config.saleId],
);
const initialStock = sale.rows[0]?.initial_stock ?? null;
const pgRows = await pool.query<{ user_id: string; stream_id: string }>(
  'SELECT user_id, stream_id FROM orders WHERE sale_id = $1',
  [config.saleId],
);
await pool.end();

// Best-effort Redis read: a bounded attempt so the report still runs when Redis
// is down (e.g. right after a failover). Returns null if Redis is unreachable.
async function readRedisWinners(): Promise<Set<string> | null> {
  const redis: SaleRedis = createRedisClient(config.redisUrl);
  try {
    // Wait for the connection, but bounded — a dead Redis never becomes ready,
    // so the timeout is what lets the report proceed on Postgres alone.
    await Promise.race([
      awaitReady(redis),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis timeout')), 2500),
      ),
    ]);
    return new Set(await redis.smembers(keys.purchasers));
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}
const redisWinners = await readRedisWinners();

// A pg:<epoch> stamp means Postgres decided the order; anything else is a
// drained Redis win. A Redis winner not yet in orders still counts as redis.
const decidedBy = new Map<string, string>();
for (const row of pgRows.rows) {
  decidedBy.set(row.user_id, row.stream_id.startsWith('pg:') ? 'postgres' : 'redis');
}
if (redisWinners) {
  for (const user of redisWinners) {
    if (!decidedBy.has(user)) decidedBy.set(user, 'redis');
  }
}

const winnerSet = new Set([
  ...pgRows.rows.map((row) => row.user_id),
  ...(redisWinners ?? []),
]);
const contenders = Array.from({ length: totalUsers }, (_, i) => idFor(i));
const contenderSet = new Set(contenders);

const rows = contenders.map((userId) => ({
  userId,
  outcome: winnerSet.has(userId) ? 'won' : 'lost',
  decidedBy: decidedBy.get(userId) ?? '',
}));
const winners = rows.filter((row) => row.outcome === 'won');
const losers = rows.filter((row) => row.outcome === 'lost');
const otherWinners = [...winnerSet].filter((user) => !contenderSet.has(user));
const oversold = initialStock !== null && winnerSet.size > initialStock;

const csv = [
  'userId,outcome,decided_by',
  ...rows.map((row) => `${row.userId},${row.outcome},${row.decidedBy}`),
].join('\n');
await writeFile(resolve(k6Dir, 'report.csv'), `${csv}\n`);

const report = {
  saleId: config.saleId,
  initialStock,
  contenders: totalUsers,
  winners: winners.map((row) => row.userId),
  losers: losers.map((row) => row.userId),
  otherWinners,
  oversold,
  crossCheck: {
    redisWinners: redisWinners ? redisWinners.size : 'redis unavailable',
    postgresOrders: pgRows.rowCount ?? 0,
    unionWinners: winnerSet.size,
  },
};
await writeFile(
  resolve(k6Dir, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

const line = (label: string, value: string | number) =>
  `  ${label.padEnd(16)}${String(value).padStart(9)}`;
console.log(
  [
    `\nWinners / losers — sale "${config.saleId}"`,
    line('initial stock', initialStock ?? '?'),
    line('contenders', totalUsers),
    line('winners', winners.length),
    line('losers', losers.length),
    line('redis winners', redisWinners ? redisWinners.size : 'down'),
    line('postgres orders', pgRows.rowCount ?? 0),
    line('union winners', winnerSet.size),
    line('oversold', oversold ? 'YES' : 'no'),
    otherWinners.length ? line('other winners', otherWinners.length) : '',
    `\n  → ${resolve(k6Dir, 'report.csv')}`,
    `  → ${resolve(k6Dir, 'report.json')}`,
  ]
    .filter(Boolean)
    .join('\n'),
);
