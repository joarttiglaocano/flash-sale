import type { PgPool } from '../pg.js';
import { failForwardToPostgres, getControl, type Allocator } from './control.js';

export interface RouterState {
  allocator: Allocator;
  epoch: number;
}

export interface ControlRouter {
  /** The current decider, from a short-lived cache of the control row. */
  resolve(): Promise<RouterState>;
  /** Flip the decider to postgres (automatic fail-forward). Idempotent. */
  failForward(reason: string): Promise<void>;
  /** Drop the cache so the next resolve() re-reads control immediately. */
  invalidate(): void;
}

// A missing control row (unseeded sale) — or a process with no database at
// all — can only mean "Redis decides": there is nothing else to route to,
// and no flag to read.
const REDIS_ONLY: RouterState = { allocator: 'redis', epoch: 1 };

export interface RouterOptions {
  pool?: PgPool;
  saleId: string;
  /** Cache lifetime for the control read; keeps the hot path off Postgres. */
  ttlMs?: number;
  /** Real-time clock for the TTL — deliberately NOT the pinned sale clock. */
  now?: () => number;
}

/**
 * Resolves which store decides each request by reading the `control` flag,
 * cached for `ttlMs` so the fast Redis path pays at most one control query
 * per second instead of one per request. The bounded staleness is safe:
 * both deciders are individually correct, and the failback parks traffic for
 * a full TTL before its final flip, so a stale read never straddles a switch.
 */
export function createRouter({
  pool,
  saleId,
  ttlMs = 1000,
  now = () => Date.now(),
}: RouterOptions): ControlRouter {
  if (!pool) {
    return {
      resolve: () => Promise.resolve(REDIS_ONLY),
      failForward: () => Promise.resolve(),
      invalidate: () => {},
    };
  }

  let cached: RouterState | null = null;
  let cachedAt = 0;

  async function read(): Promise<RouterState> {
    const control = await getControl(pool as PgPool, saleId);
    return control
      ? { allocator: control.allocator, epoch: control.epoch }
      : REDIS_ONLY;
  }

  return {
    async resolve() {
      const nowMs = now();
      if (cached && nowMs - cachedAt < ttlMs) return cached;
      cached = await read();
      cachedAt = nowMs;
      return cached;
    },

    async failForward(reason: string) {
      // Loud on purpose: this is the system deciding, unattended, that Redis
      // is unusable. Update the cache in place so the request that triggered
      // the fail-forward can be retried against Postgres without waiting out
      // the TTL.
      console.warn(
        `[failover] failing forward to postgres for sale "${saleId}": ${reason}`,
      );
      // Reconciles Postgres's stock counter as part of the flip so
      // the fallback starts from the true order count, not a stale-high one.
      const state = await failForwardToPostgres(pool as PgPool, saleId);
      cached = { allocator: state.allocator, epoch: state.epoch };
      cachedAt = now();
    },

    invalidate() {
      cached = null;
      cachedAt = 0;
    },
  };
}
