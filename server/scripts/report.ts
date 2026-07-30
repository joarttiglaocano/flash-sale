import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import { awaitReady, createRedisClient, saleKeys } from '../src/redis.js';

/**
 * Post-run winners/losers report. Writes k6/report.csv (one row per contender:
 * userId, outcome, decided_by) and k6/report.json (the same, plus per-store
 * counts), and prints a summary table.
 *
 * Losers are never stored anywhere — only winners are — so the field of
 * contenders is rebuilt from the load's deterministic id scheme and the winners
 * subtracted. Defaults match the k6 stress script (k6-user-0 ..); override for a
 * custom load: TOTAL_USERS=15000 USER_TEMPLATE='buyer-{i}@example.com'.
 *
 * A winner is anyone holding an item in EITHER store — the Redis purchaser set
 * or the Postgres orders table — so the list stays complete across a failover,
 * where neither store alone has everyone.
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
const redis = await awaitReady(createRedisClient(config.redisUrl));
const pool = createPgPool(config.databaseUrl);

const rawInitial = await redis.get(keys.initialStock);
const initialStock = rawInitial === null ? null : Number(rawInitial);

const redisWinners = new Set(await redis.smembers(keys.purchasers));
const pgRows = await pool.query<{ user_id: string; stream_id: string }>(
  'SELECT user_id, stream_id FROM orders WHERE sale_id = $1',
  [config.saleId],
);
await pool.end();
await redis.quit();

// A pg:<epoch> stamp means Postgres decided the order; anything else is a
// drained Redis win. A Redis winner not yet in orders still counts as redis.
const decidedBy = new Map<string, string>();
for (const row of pgRows.rows) {
  decidedBy.set(row.user_id, row.stream_id.startsWith('pg:') ? 'postgres' : 'redis');
}
for (const user of redisWinners) {
  if (!decidedBy.has(user)) decidedBy.set(user, 'redis');
}

const winnerSet = new Set([
  ...redisWinners,
  ...pgRows.rows.map((row) => row.user_id),
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
// Winners outside the reconstructed field (a manual buyer, or a different load).
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
    redisWinners: redisWinners.size,
    postgresOrders: pgRows.rowCount ?? 0,
    unionWinners: winnerSet.size,
  },
};
await writeFile(
  resolve(k6Dir, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

const row = (label: string, value: string | number) =>
  `  ${label.padEnd(16)}${String(value).padStart(7)}`;
console.log(
  [
    `\nWinners / losers — sale "${config.saleId}"`,
    row('initial stock', initialStock ?? '?'),
    row('contenders', totalUsers),
    row('winners', winners.length),
    row('losers', losers.length),
    row('redis winners', redisWinners.size),
    row('postgres orders', pgRows.rowCount ?? 0),
    row('union winners', winnerSet.size),
    `  ${'oversold'.padEnd(16)}${(oversold ? 'YES' : 'no').padStart(7)}`,
    otherWinners.length
      ? row('other winners', otherWinners.length)
      : '',
    `\n  → ${resolve(k6Dir, 'report.csv')}`,
    `  → ${resolve(k6Dir, 'report.json')}`,
  ]
    .filter(Boolean)
    .join('\n'),
);
