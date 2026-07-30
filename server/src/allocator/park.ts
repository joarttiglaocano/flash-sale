import type { ControlRouter, RouterState } from './router.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ParkOptions {
  /** Give up and let the caller answer a hold-safe 503 after this long. */
  timeoutMs?: number;
  /** How often to re-check the flag while parked. */
  pollMs?: number;
  /** Real-time clock for the deadline (not the pinned sale clock). */
  now?: () => number;
}

/**
 * Holds a purchase request while the control flag reads `cutover` — the brief
 * window in which a failback is switching the decider back to a fresh Redis.
 * Requests are HELD, not rejected: it polls the flag until it leaves cutover
 * (then returns the new decider so the caller proceeds) or the timeout elapses
 * (then the flag is still `cutover` and the caller answers a hold-safe 503,
 * which the buyer can retry idempotently).
 *
 * Per-request polling rather than a shared gate is deliberate: cutover is
 * sub-second by design, so the poll count stays tiny, and there is no
 * background-loop lifecycle to leak. The router cache is bypassed each poll so
 * the release is seen within `pollMs`, not within the cache TTL.
 */
export async function parkForCutover(
  route: ControlRouter,
  { timeoutMs = 10_000, pollMs = 100, now = () => Date.now() }: ParkOptions = {},
): Promise<RouterState> {
  const deadline = now() + timeoutMs;
  let state = await fresh(route);
  while (state.allocator === 'cutover' && now() < deadline) {
    await delay(pollMs);
    state = await fresh(route);
  }
  return state;
}

async function fresh(route: ControlRouter): Promise<RouterState> {
  route.invalidate();
  return route.resolve();
}
