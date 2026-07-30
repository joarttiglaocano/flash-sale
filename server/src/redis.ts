import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';

export type PurchaseOutcome =
  | 'PURCHASED'
  | 'ALREADY_PURCHASED'
  | 'SOLD_OUT'
  | 'NOT_INITIALIZED';

export interface SaleRedis extends Redis {
  purchase(
    stockKey: string,
    purchasersKey: string,
    winsKey: string,
    userId: string,
    saleId: string,
  ): Promise<PurchaseOutcome>;
}

export interface SaleKeys {
  stock: string;
  initialStock: string;
  purchasers: string;
  startsAt: string;
  endsAt: string;
  wins: string;
  /** Fencing token: the control epoch stamped into a freshly-rebuilt Redis. */
  epoch: string;
}

/** Consumer group that drains the wins stream into Postgres. */
export const WINS_GROUP = 'pg-writer';

export function saleKeys(saleId: string): SaleKeys {
  return {
    stock: `sale:${saleId}:stock`,
    initialStock: `sale:${saleId}:initialStock`,
    purchasers: `sale:${saleId}:purchasers`,
    startsAt: `sale:${saleId}:startsAt`,
    endsAt: `sale:${saleId}:endsAt`,
    wins: `sale:${saleId}:wins`,
    epoch: `sale:${saleId}:epoch`,
  };
}

const purchaseLua = readFileSync(
  new URL('./lua/purchase.lua', import.meta.url),
  'utf8',
);

// Commands issued before the connection is ready fail immediately
// (surfaced as 503) instead of queueing in memory during an outage.
export function awaitReady(client: SaleRedis): Promise<SaleRedis> {
  if (client.status === 'ready') return Promise.resolve(client);
  return new Promise((resolve, reject) => {
    client.once('ready', () => resolve(client));
    client.once('error', reject);
  });
}

export function createRedisClient(redisUrl: string): SaleRedis {
  const client = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }) as SaleRedis;

  // ioredis sends EVALSHA and falls back to EVAL if Redis restarted and
  // lost the script cache.
  client.defineCommand('purchase', {
    numberOfKeys: 3,
    lua: purchaseLua,
  });

  return client;
}
