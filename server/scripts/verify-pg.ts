import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';

/**
 * Postgres-mode invariant checker — the counterpart to verify.ts for runs
 * where Postgres was the decider (PURCHASE_BACKEND=postgres). verify.ts
 * asserts Redis⇄Postgres agreement, which is meaningless here: the Redis
 * stock/purchasers keys never moved because decisions went to Postgres.
 * This asserts the correctness invariants against Postgres alone, then
 * cross-checks the k6 outcome counters if a summary is present.
 */
const config = loadConfig();
const pool = createPgPool(config.databaseUrl);

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}
const results: CheckResult[] = [];
function checkInvariant(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

const sale = await pool.query<{ initial_stock: number; remaining: number }>(
  'SELECT initial_stock, remaining FROM sales WHERE sale_id = $1',
  [config.saleId],
);
const saleRow = sale.rows[0];

const orders = await pool.query<{ total: number; distinct_users: number }>(
  `SELECT count(*)::int AS total,
          count(DISTINCT user_id)::int AS distinct_users
     FROM orders WHERE sale_id = $1`,
  [config.saleId],
);
const { total: orderCount, distinct_users: distinctUsers } = orders.rows[0] ?? {
  total: 0,
  distinct_users: 0,
};

const control = await pool.query<{ allocator: string; epoch: number }>(
  'SELECT allocator, epoch FROM control WHERE sale_id = $1',
  [config.saleId],
);
const controlRow = control.rows[0];

// Every Postgres-decided order is stamped pg:<epoch>. Any other stream_id
// means an order arrived from a different path (a Redis-drained win, or a
// mismatched epoch) — worth surfacing, not asserting-away.
const stamps = await pool.query<{ stream_id: string; n: number }>(
  `SELECT stream_id, count(*)::int AS n
     FROM orders WHERE sale_id = $1 GROUP BY stream_id ORDER BY n DESC`,
  [config.saleId],
);
// A valid order stamp is either postgres-decided (`pg:<epoch>`) or a redis-
// decided win drained by the consumer (a redis stream id, `<ms>-<seq>`). After
// a failover, orders are legitimately a mix of both; anything else is unexpected.
const validStamp = /^(pg:\d+|\d+-\d+)$/;
const foreignStamps = stamps.rows.filter((r) => !validStamp.test(r.stream_id));

checkInvariant(
  'sales row exists (postgres can decide)',
  saleRow !== undefined,
  saleRow ? `initial=${saleRow.initial_stock}, remaining=${saleRow.remaining}` : 'no sales row',
);
checkInvariant(
  'remaining never negative',
  saleRow !== undefined && saleRow.remaining >= 0,
  `remaining=${saleRow?.remaining}`,
);
checkInvariant(
  'orders == initial - remaining (no oversell, no loss)',
  saleRow !== undefined && orderCount === saleRow.initial_stock - saleRow.remaining,
  `orders=${orderCount}, initial=${saleRow?.initial_stock}, remaining=${saleRow?.remaining}`,
);
checkInvariant(
  'orders never exceed initial stock',
  saleRow !== undefined && orderCount <= saleRow.initial_stock,
  `orders=${orderCount}, initial=${saleRow?.initial_stock}`,
);
checkInvariant(
  'one item per user (distinct == total orders)',
  distinctUsers === orderCount,
  `distinct=${distinctUsers}, orders=${orderCount}`,
);
checkInvariant(
  'control row exists',
  controlRow !== undefined,
  controlRow ? `allocator=${controlRow.allocator}, epoch=${controlRow.epoch}` : 'no control row',
);
checkInvariant(
  'every order stamped pg:<epoch> or a drained redis win',
  orderCount === 0 || foreignStamps.length === 0,
  foreignStamps.length === 0
    ? `all ${orderCount} orders have a valid provenance stamp`
    : `unexpected stamps: ${foreignStamps.map((s) => `${s.stream_id}×${s.n}`).slice(0, 3).join(', ')}`,
);

// --- k6 cross-checks (optional, same summary.json verify.ts reads) ---
// k6 cross-checks apply ONLY to a summary from THIS sale's most recent stress
// run. Skip a summary that is stale (predates this run) or reports more
// purchases than this sale could ever have — it is from an unrelated run.
const STALE_MIN = 10;
let k6: Record<string, number> | null = null;
let k6Skip: string | null = null;
for (const rel of ['../k6/summary.json', 'k6/summary.json']) {
  const full = resolve(process.cwd(), rel);
  let parsed: Record<string, number>;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8')) as Record<string, number>;
  } catch {
    continue; // not at this path — try the next
  }
  const ageMin = (Date.now() - statSync(full).mtimeMs) / 60_000;
  if (ageMin > STALE_MIN) {
    k6Skip = `summary is ${Math.round(ageMin)} min old — looks stale`;
  } else if (
    saleRow !== undefined &&
    parsed.purchased !== undefined &&
    parsed.purchased > saleRow.initial_stock
  ) {
    k6Skip =
      `summary reports ${parsed.purchased} purchases > this sale's ` +
      `stock ${saleRow.initial_stock} — it is from a different run`;
  } else {
    k6 = parsed;
  }
  break;
}

if (k6) {
  checkInvariant('zero uncontracted responses', k6.unexpected === 0, `unexpected=${k6.unexpected}`);
  checkInvariant('sale window active for the whole run', k6.sale_inactive === 0, `sale_inactive=${k6.sale_inactive}`);
  checkInvariant(
    'every k6 201 corresponds to exactly one durable order',
    k6.purchased === orderCount,
    `k6 purchased=${k6.purchased}, postgres orders=${orderCount}`,
  );

  const total = k6.total_users;
  if (total !== undefined && saleRow !== undefined) {
    const expectedWins = Math.min(total, saleRow.initial_stock);
    checkInvariant(
      `deterministic outcome: exactly min(users, stock) = ${expectedWins} purchases`,
      k6.purchased === expectedWins,
      `purchased=${k6.purchased}, expected=${expectedWins}`,
    );
    checkInvariant(
      'wave 2 idempotency: every winner got ALREADY_PURCHASED, zero new wins',
      k6.already_purchased === expectedWins,
      `already_purchased=${k6.already_purchased}, expected=${expectedWins}`,
    );
    checkInvariant(
      'losers rejected in both waves',
      k6.sold_out === 2 * (total - expectedWins),
      `sold_out=${k6.sold_out}, expected=${2 * (total - expectedWins)}`,
    );
  }
} else if (k6Skip) {
  console.log(`(skipping k6 cross-checks: ${k6Skip})`);
  console.log('(run `npm run stress` against a PURCHASE_BACKEND=postgres server immediately before verify to include them)');
} else {
  console.log('(k6/summary.json not found — skipping k6 cross-checks)');
  console.log('(run `npm run stress` against a PURCHASE_BACKEND=postgres server, then verify immediately)');
}

await pool.end();

const width = Math.max(...results.map((r) => r.name.length));
console.log('\nPostgres invariant check — sale "' + config.saleId + '"');
console.log('-'.repeat(width + 12));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log('-'.repeat(width + 12));

if (results.some((r) => !r.pass)) {
  console.error('\nRESULT: FAIL');
  process.exit(1);
}
console.log('\nRESULT: PASS — postgres decided every purchase, no oversell, no loss, one per user.');
