import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

// Deterministic stress scenario:
//   wave 1 (race):  10,000 unique users race for 5,000 items
//                   → exactly 5,000 × 201 PURCHASED, 5,000 × 409 SOLD_OUT
//   wave 2 (retry): the same 10,000 users all try again
//                   → exactly 5,000 × 200 ALREADY_PURCHASED (the winners),
//                     5,000 × 409 SOLD_OUT (the losers), zero new purchases
// Any other response counts toward `unexpected`, which fails the run.
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOTAL_USERS = Number(__ENV.TOTAL_USERS || 10000);
const VUS = Number(__ENV.VUS || 500);

export const options = {
  scenarios: {
    race: {
      executor: 'shared-iterations',
      exec: 'race',
      vus: VUS,
      iterations: TOTAL_USERS,
      maxDuration: '60s',
    },
    retry_all: {
      executor: 'shared-iterations',
      exec: 'retryAll',
      vus: VUS,
      iterations: TOTAL_USERS,
      maxDuration: '60s',
      startTime: '65s',
    },
  },
  thresholds: {
    unexpected: ['count<1'],
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:race}': ['p(95)<200'],
  },
};

// 403/409 are contracted business outcomes, not failures — without this,
// k6 counts every SOLD_OUT as a failed request.
http.setResponseCallback(http.expectedStatuses(200, 201, 403, 409));

const purchased = new Counter('purchased');
const alreadyPurchased = new Counter('already_purchased');
const soldOut = new Counter('sold_out');
const saleInactive = new Counter('sale_inactive');
const unexpected = new Counter('unexpected');

function attempt(userId) {
  const res = http.post(
    `${BASE_URL}/api/purchase`,
    JSON.stringify({ userId }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  let code = '';
  try {
    code = res.json('code');
  } catch (_) {
    code = '';
  }

  if (res.status === 201 && code === 'PURCHASED') purchased.add(1);
  else if (res.status === 200 && code === 'ALREADY_PURCHASED')
    alreadyPurchased.add(1);
  else if (res.status === 409 && code === 'SOLD_OUT') soldOut.add(1);
  else if (
    res.status === 403 &&
    (code === 'SALE_NOT_STARTED' || code === 'SALE_ENDED')
  )
    saleInactive.add(1);
  else unexpected.add(1);

  check(res, {
    'contracted response': () => [200, 201, 403, 409].includes(res.status),
  });
}

// exec.scenario.iterationInTest is zero-based and unique within each
// scenario across all VUs, so both waves address the same user ids.
export function race() {
  attempt(`k6-user-${exec.scenario.iterationInTest}`);
}

export function retryAll() {
  attempt(`k6-user-${exec.scenario.iterationInTest}`);
}

export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] ? data.metrics[name].values.count : 0;
  const summary = {
    total_users: TOTAL_USERS,
    purchased: c('purchased'),
    already_purchased: c('already_purchased'),
    sold_out: c('sold_out'),
    sale_inactive: c('sale_inactive'),
    unexpected: c('unexpected'),
    http_reqs: c('http_reqs'),
    p95_ms: data.metrics.http_req_duration
      ? Math.round(data.metrics.http_req_duration.values['p(95)'] * 100) / 100
      : null,
  };
  return {
    stdout: `\nOutcome counters: ${JSON.stringify(summary, null, 2)}\n`,
    '/scripts/summary.json': JSON.stringify(summary, null, 2),
  };
}
