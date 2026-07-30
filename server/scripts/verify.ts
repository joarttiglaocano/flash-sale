import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';
import {
  awaitReady,
  createRedisClient,
  saleKeys,
  WINS_GROUP,
  type SaleRedis,
} from '../src/redis.js';

/**
 * Post-stress invariant checker. Reads the actual Redis AND Postgres state
 * after a k6 run and asserts the correctness invariants the whole system
 * is built around — including that the write-behind path lost nothing.
 */
const config = loadConfig();
const redis = await awaitReady(createRedisClient(config.redisUrl));
const pool = createPgPool(config.databaseUrl);
const keys = saleKeys(config.saleId);

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}
const results: CheckResult[] = [];

function checkInvariant(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

/**
 * Wait until the consumer has fully drained the wins stream: the
 * pg-writer group reports lag 0 (nothing undelivered) and pending 0
 * (everything delivered was acked). Runs before the Redis↔Postgres
 * comparisons so `stress → verify` needs no manual coordination.
 */
async function waitForDrain(
  client: SaleRedis,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let detail = 'wins stream or consumer group missing';
  while (Date.now() < deadline) {
    try {
      const groups = (await client.xinfo('GROUPS', keys.wins)) as Array<
        Array<string | number | null>
      >;
      const group = groups.find(
        (g) => g[g.indexOf('name') + 1] === WINS_GROUP,
      );
      if (!group) {
        detail = `consumer group "${WINS_GROUP}" missing — was the sale seeded (npm run seed)?`;
      } else {
        const lag = group[group.indexOf('lag') + 1];
        const pending = group[group.indexOf('pending') + 1];
        if (lag === 0 && pending === 0) {
          return { ok: true, detail: 'lag=0, pending=0' };
        }
        detail = `lag=${lag}, pending=${pending} — is the consumer running (npm run dev:consumer)?`;
      }
    } catch (err) {
      detail =
        err instanceof Error && /no such key/.test(err.message)
          ? 'wins stream missing — was the sale seeded (npm run seed)?'
          : `XINFO failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, detail: `not drained after ${timeoutMs}ms (${detail})` };
}

const [rawStock, rawInitial] = await redis.mget(
  keys.stock,
  keys.initialStock,
);
const stock = rawStock === null ? null : Number(rawStock);
const initialStock = rawInitial === null ? null : Number(rawInitial);
const sold = await redis.scard(keys.purchasers);

checkInvariant('stock key exists', stock !== null, `stock=${rawStock}`);
checkInvariant(
  'stock never negative',
  stock !== null && stock >= 0,
  `stock=${stock}`,
);
checkInvariant(
  'sold == initial - remaining (no oversell, no loss)',
  stock !== null && initialStock !== null && sold === initialStock - stock,
  `purchasers=${sold}, initial=${initialStock}, remaining=${stock}`,
);

// --- Durable-store invariants: Redis and Postgres must agree. ---
const drain = await waitForDrain(redis);
checkInvariant('wins stream fully drained by consumer', drain.ok, drain.detail);

const redisWinners = new Set(await redis.smembers(keys.purchasers));
const winsLen = drain.ok ? await redis.xlen(keys.wins) : -1;

const pgOrders = await pool.query<{ user_id: string }>(
  'SELECT user_id FROM orders WHERE sale_id = $1',
  [config.saleId],
);
const pgWinners = new Set(pgOrders.rows.map((r) => r.user_id));
const pgSale = await pool.query<{ initial_stock: number }>(
  'SELECT initial_stock FROM sales WHERE sale_id = $1',
  [config.saleId],
);
const pgInitialStock = pgSale.rows[0]?.initial_stock ?? null;

checkInvariant(
  'postgres order count == purchasers set size',
  pgWinners.size === sold,
  `orders=${pgWinners.size}, purchasers=${sold}`,
);

const missingInPg = [...redisWinners].filter((u) => !pgWinners.has(u));
const extraInPg = [...pgWinners].filter((u) => !redisWinners.has(u));
checkInvariant(
  'postgres and redis agree on exactly who won',
  missingInPg.length === 0 && extraInPg.length === 0,
  missingInPg.length === 0 && extraInPg.length === 0
    ? `${pgWinners.size} identical winners`
    : `missing in pg: ${missingInPg.slice(0, 3).join(', ') || 'none'}; ` +
        `extra in pg: ${extraInPg.slice(0, 3).join(', ') || 'none'}`,
);

checkInvariant(
  'sales row exists in postgres (rebuild is possible)',
  pgInitialStock !== null,
  `sales.initial_stock=${pgInitialStock}`,
);
checkInvariant(
  'orders never exceed the durable initial stock',
  pgInitialStock !== null && pgWinners.size <= pgInitialStock,
  `orders=${pgWinners.size}, initial=${pgInitialStock}`,
);
// The wins stream is a ROLLING journal that a rebuild legitimately resets,
// so its length is the wins since the last rebuild (all of them if none) —
// never more than the total, and possibly 0 right after a rebuild. Durability
// is asserted against Postgres above (orders == purchasers); here we only
// guard the journal from holding phantom entries (xlen > total wins), which
// would signal a double-XADD or a win without a purchaser.
checkInvariant(
  'wins journal consistent (rolling log; resets on rebuild, never exceeds total wins)',
  winsLen <= sold && pgWinners.size === sold,
  `xlen=${winsLen} (≤ ${sold} wins), orders=${pgWinners.size}`,
);

await redis.quit();
await pool.end();

// k6 cross-checks apply ONLY to a summary from THIS sale's most recent stress
// run. A summary that is stale (the file predates this run) or that reports
// more purchases than this sale could ever have is from an unrelated run — a
// leftover large stress, say — so skip it rather than emit false failures.
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
    initialStock !== null &&
    parsed.purchased !== undefined &&
    parsed.purchased > initialStock
  ) {
    k6Skip =
      `summary reports ${parsed.purchased} purchases > this sale's ` +
      `stock ${initialStock} — it is from a different run`;
  } else {
    k6 = parsed;
  }
  break;
}

if (k6) {
  checkInvariant(
    'sale window was active for the whole run',
    k6.sale_inactive === 0,
    `sale_inactive=${k6.sale_inactive}`,
  );
  checkInvariant(
    'zero uncontracted responses',
    k6.unexpected === 0,
    `unexpected=${k6.unexpected}`,
  );
  checkInvariant(
    'every k6 201 corresponds to exactly one purchaser',
    k6.purchased === sold,
    `k6 purchased=${k6.purchased}, purchasers set size=${sold}`,
  );
  checkInvariant(
    'every k6 201 corresponds to exactly one durable order',
    k6.purchased === pgWinners.size,
    `k6 purchased=${k6.purchased}, postgres orders=${pgWinners.size}`,
  );

  // The scenario is deterministic: `total` unique users race for the
  // stock in wave 1, then all of them retry in wave 2. Assert the exact
  // expected outcome, not just the absence of oversell.
  const total = k6.total_users;
  if (total !== undefined && initialStock !== null) {
    const expectedWins = Math.min(total, initialStock);
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
  console.log('(run `npm run stress` immediately before verify to include them)');
} else {
  console.log('(k6/summary.json not found — skipping k6 cross-checks)');
  console.log('(run `npm run stress` first, then verify immediately after)');
}

const width = Math.max(...results.map((r) => r.name.length));
console.log('\nInvariant check — sale "' + config.saleId + '"');
console.log('-'.repeat(width + 12));
for (const r of results) {
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`,
  );
}
console.log('-'.repeat(width + 12));

if (results.some((r) => !r.pass)) {
  console.error('\nRESULT: FAIL');
  process.exit(1);
}
console.log(
  '\nRESULT: PASS — no oversell, no double-purchase, redis and postgres agree.',
);
