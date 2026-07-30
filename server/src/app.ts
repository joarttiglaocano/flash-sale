import cors from 'cors';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { parkForCutover, type ParkOptions } from './allocator/park.js';
import { purchaseViaPostgres } from './allocator/postgres.js';
import { createRouter, type ControlRouter } from './allocator/router.js';
import type { AppConfig } from './config.js';
import type { PgPool } from './pg.js';
import { saleKeys, type PurchaseOutcome, type SaleRedis } from './redis.js';
import {
  postgresWindowProvider,
  redisWindowProvider,
  type WindowProvider,
} from './sale/store.js';
import { getSaleStatus } from './sale/window.js';
import { purchaseBodySchema, userIdSchema } from './validate.js';

export interface AppDeps {
  config: AppConfig;
  redis: SaleRedis;
  /** Injectable clock so tests can pin the sale window state. */
  now?: () => Date;
  window?: WindowProvider;
  pool?: PgPool;
  /**
   * Per-request decider. Defaults to one built from `pool` + the
   * control table; without a pool it is redis-only. Inject to control the
   * cache TTL/clock in tests.
   */
  router?: ControlRouter;
  /** Cutover park tuning (hold timeout / poll interval). */
  park?: ParkOptions;
}

interface OutcomeResponse {
  code: string;
  message: string;
}

const OUTCOMES: Record<string, { status: number; body: OutcomeResponse }> = {
  PURCHASED: {
    status: 201,
    body: { code: 'PURCHASED', message: 'Item secured. You got one!' },
  },
  ALREADY_PURCHASED: {
    status: 200,
    body: {
      code: 'ALREADY_PURCHASED',
      message: 'This user already secured an item — one per customer.',
    },
  },
  SOLD_OUT: {
    status: 409,
    body: { code: 'SOLD_OUT', message: 'All items are gone.' },
  },
  NOT_INITIALIZED: {
    status: 503,
    body: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Sale inventory is not initialized.',
    },
  },
};

const SERVICE_UNAVAILABLE: OutcomeResponse = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'Temporarily unavailable — safe to retry.',
};

const NOT_SEEDED: OutcomeResponse = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'Sale is not initialized — run the seed script.',
};

export function buildApp({
  config,
  redis,
  now = () => new Date(),
  window: windowProvider,
  pool,
  router,
  park: parkOptions,
}: AppDeps): Express {
  const app = express();
  const keys = saleKeys(config.saleId);
  const route =
    router ??
    createRouter({ saleId: config.saleId, ...(pool ? { pool } : {}) });

  // Both window sources are built once; each request picks one by the decider
  // the router resolves. An injected provider (tests) always wins.
  const redisWindows = redisWindowProvider(redis, keys);
  const pgWindows = pool ? postgresWindowProvider(pool, config.saleId) : null;
  const windowsFor = (usePg: boolean): WindowProvider =>
    windowProvider ?? (usePg && pgWindows ? pgWindows : redisWindows);

  // The read model follows the SAME decider as the write path, so the buyer
  // sees the store that actually decided (stock draining, "already bought",
  // health) rather than a counter the other store never touched.
  const readStock = async (
    usePg: boolean,
  ): Promise<{ remaining: number; initial: number }> => {
    if (usePg && pool) {
      const result = await pool.query<{
        initial_stock: number;
        remaining: number;
      }>('SELECT initial_stock, remaining FROM sales WHERE sale_id = $1', [
        config.saleId,
      ]);
      const row = result.rows[0];
      return row
        ? { remaining: Math.max(0, row.remaining), initial: row.initial_stock }
        : { remaining: 0, initial: 0 };
    }
    const [rawStock, rawInitial] = await redis.mget(
      keys.stock,
      keys.initialStock,
    );
    return {
      remaining: rawStock === null ? 0 : Math.max(0, Number(rawStock)),
      initial: Number(rawInitial),
    };
  };

  const hasPurchased = async (
    usePg: boolean,
    userId: string,
  ): Promise<boolean> => {
    if (usePg && pool) {
      const result = await pool.query(
        'SELECT 1 FROM orders WHERE sale_id = $1 AND user_id = $2',
        [config.saleId, userId],
      );
      return (result.rowCount ?? 0) > 0;
    }
    return (await redis.sismember(keys.purchasers, userId)) === 1;
  };

  app.use(cors());
  app.use(express.json());

  app.get('/healthcheck', async (_req: Request, res: Response) => {
    const { allocator } = await route.resolve();
    // Whether the Postgres fallback is wired at all. Without it the server is
    // running Redis-only (FALLBACK=off) and can never fail over — surface that
    // here so an operator can tell the two modes apart before Redis dies.
    const fallback = pool ? 'on' : 'off';
    // Reads follow the decider; postgres and cutover both read from Postgres,
    // so the system is healthy even with Redis gone — the whole point of v3.
    const usePg = allocator !== 'redis' && pool !== undefined;
    try {
      if (usePg && pool) {
        await pool.query('SELECT 1');
      } else {
        await redis.ping();
      }
      res.json({ status: 'ok', decider: allocator, fallback });
    } catch {
      res.status(503).json({ status: 'degraded', decider: allocator, fallback });
    }
  });

  app.get('/api/sale/status', async (_req: Request, res: Response) => {
    const at = now();
    const readStatus = async (
      usePg: boolean,
    ): Promise<{ http: number; body: object }> => {
      const saleWindow = await windowsFor(usePg).get();
      if (!saleWindow) return { http: 503, body: NOT_SEEDED };
      const { remaining, initial } = await readStock(usePg);
      return {
        http: 200,
        body: {
          status: getSaleStatus(at, saleWindow),
          startsAt: saleWindow.startsAt.toISOString(),
          endsAt: saleWindow.endsAt.toISOString(),
          serverTime: at.toISOString(),
          stockRemaining: remaining,
          initialStock: initial,
          soldOut: remaining <= 0,
        },
      };
    };

    try {
      const { allocator } = await route.resolve();
      if (allocator !== 'redis') {
        const reply = await readStatus(true);
        res.status(reply.http).json(reply.body);
        return;
      }
      // The buyer's page only polls this endpoint, so reads must fail forward
      // too — otherwise a dead Redis pins every poll at 503, the page disables
      // Buy, and no purchase ever arrives to trip the flip. Failing forward
      // here lets the page recover on its own next poll.
      try {
        const reply = await readStatus(false);
        res.status(reply.http).json(reply.body);
      } catch (err) {
        if (!pool) throw err;
        await route.failForward(err instanceof Error ? err.message : String(err));
        const reply = await readStatus(true);
        res.status(reply.http).json(reply.body);
      }
    } catch {
      res.status(503).json(SERVICE_UNAVAILABLE);
    }
  });

  app.post('/api/purchase', async (req: Request, res: Response) => {
    const parsed = purchaseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      });
      return;
    }
    const userId = parsed.data.userId;

    // One purchase attempt against the chosen store: window check + decision.
    // Business outcomes (not-seeded, upcoming/ended, sold-out) are RETURNED;
    // only an infrastructure failure (e.g. Redis down) THROWS — that split is
    // what lets fail-forward fire on a dead store but never on a SOLD_OUT.
    const attempt = async (
      usePg: boolean,
      epoch: number,
    ): Promise<{ http: number; body: OutcomeResponse }> => {
      const saleWindow = await windowsFor(usePg).get();
      if (!saleWindow) return { http: 503, body: NOT_SEEDED };
      const status = getSaleStatus(now(), saleWindow);
      if (status === 'upcoming') {
        return {
          http: 403,
          body: {
            code: 'SALE_NOT_STARTED',
            message: 'The sale has not started yet.',
          },
        };
      }
      if (status === 'ended') {
        return {
          http: 403,
          body: { code: 'SALE_ENDED', message: 'The sale is over.' },
        };
      }
      let outcome: PurchaseOutcome;
      if (usePg && pool) {
        outcome = await purchaseViaPostgres(pool, config.saleId, userId, epoch);
      } else {
        // Fencing: after a failback (epoch > 1) the live Redis must carry the
        // matching epoch. A mismatch means a stale, never-rebuilt Redis — throw
        // so the request fails forward instead of trusting a wrong generation.
        if (epoch > 1) {
          const stamped = await redis.get(keys.epoch);
          if (Number(stamped) !== epoch) {
            throw new Error(
              `redis epoch ${stamped ?? 'unset'} != control epoch ${epoch} — fencing out stale generation`,
            );
          }
        }
        outcome = await redis.purchase(
          keys.stock,
          keys.purchasers,
          keys.wins,
          userId,
          config.saleId,
        );
      }
      const mapped = OUTCOMES[outcome];
      return mapped
        ? { http: mapped.status, body: mapped.body }
        : {
            http: 500,
            body: {
              code: 'INTERNAL_ERROR',
              message: 'Unexpected purchase outcome.',
            },
          };
    };

    try {
      let { allocator, epoch } = await route.resolve();
      if (allocator === 'cutover') {
        // A failback is switching the decider back to a fresh Redis. Hold the
        // request until the switch completes, then decide with the new store;
        // if the cutover overruns the timeout, a hold-safe 503 to retry.
        const parked = await parkForCutover(route, parkOptions);
        if (parked.allocator === 'cutover') {
          res.status(503).json(SERVICE_UNAVAILABLE);
          return;
        }
        allocator = parked.allocator;
        epoch = parked.epoch;
      }

      if (allocator === 'postgres') {
        const reply = await attempt(true, epoch);
        res.status(reply.http).json(reply.body);
        return;
      }

      // Redis is primary. If the Redis attempt throws — the window read or the
      // Lua call — Redis is unusable: fail forward to Postgres and decide the
      // SAME request there, so the buyer never sees the outage. With no pool
      // there is nowhere to fall back, so it stays a 503.
      try {
        const reply = await attempt(false, epoch);
        res.status(reply.http).json(reply.body);
      } catch (err) {
        if (!pool) throw err;
        await route.failForward(err instanceof Error ? err.message : String(err));
        const forwarded = await route.resolve();
        const reply = await attempt(true, forwarded.epoch);
        res.status(reply.http).json(reply.body);
      }
    } catch {
      res.status(503).json(SERVICE_UNAVAILABLE);
    }
  });

  app.get('/api/purchase/:userId', async (req: Request, res: Response) => {
    const parsed = userIdSchema.safeParse(req.params.userId);
    if (!parsed.success) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Invalid userId',
      });
      return;
    }
    try {
      const { allocator } = await route.resolve();
      const usePg = allocator !== 'redis' && pool !== undefined;
      const member = await hasPurchased(usePg, parsed.data);
      res.json({ userId: parsed.data, purchased: member });
    } catch {
      res.status(503).json(SERVICE_UNAVAILABLE);
    }
  });

  // Keep the JSON error contract for body-parser failures; the default
  // handler would return an HTML stack trace.
  app.use(
    (
      err: Error & { type?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (err.type === 'entity.parse.failed') {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Request body must be valid JSON.',
        });
        return;
      }
      if (err.type === 'entity.too.large') {
        res.status(413).json({
          code: 'VALIDATION_ERROR',
          message: 'Request body is too large.',
        });
        return;
      }
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error.',
      });
    },
  );

  return app;
}
