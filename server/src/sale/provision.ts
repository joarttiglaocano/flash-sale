import type { PgPool } from '../pg.js';
import { saleKeys, type SaleRedis } from '../redis.js';
import { stampEpoch } from '../recovery/rebuild.js';
import { ensureWinsGroup, seedSale } from './store.js';

export interface ProvisionOptions {
  stock: number;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Seeds a sale into both stores and returns the control epoch now stamped into
 * Redis. Redis gets the window, stock, and a cleared purchaser set; Postgres
 * gets the durable sale row (previous orders cleared) and a control row pinned
 * back to `redis`.
 *
 * The epoch is preserved across reseeds — only a failback moves it — and is
 * stamped back into Redis so the fence admits the freshly seeded generation.
 * Missing that stamp is what let a reseed after a past failback (epoch > 1)
 * bounce every healthy-Redis purchase forward to Postgres.
 *
 * Both stores must be reachable.
 */
export async function provisionSale(
  redis: SaleRedis,
  pool: PgPool,
  saleId: string,
  { stock, startsAt, endsAt }: ProvisionOptions,
): Promise<number> {
  const keys = saleKeys(saleId);
  await seedSale(redis, keys, { stock, startsAt, endsAt });
  await ensureWinsGroup(redis, keys);

  const client = await pool.connect();
  let epoch = 1;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders WHERE sale_id = $1', [saleId]);
    await client.query(
      `INSERT INTO sales (sale_id, initial_stock, remaining, starts_at, ends_at)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (sale_id) DO UPDATE
         SET initial_stock = EXCLUDED.initial_stock,
             remaining = EXCLUDED.remaining,
             starts_at = EXCLUDED.starts_at,
             ends_at = EXCLUDED.ends_at,
             seeded_at = now()`,
      [saleId, stock, startsAt, endsAt],
    );
    // A fresh seed always hands the sale back to Redis. Epoch is preserved
    // across reseeds — only a failback moves it.
    const control = await client.query<{ epoch: number }>(
      `INSERT INTO control (sale_id) VALUES ($1)
       ON CONFLICT (sale_id) DO UPDATE
         SET allocator = 'redis', flipped_at = now()
       RETURNING epoch`,
      [saleId],
    );
    epoch = control.rows[0]?.epoch ?? 1;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Keep Redis's fencing stamp in step with the control epoch.
  await stampEpoch(redis, keys, epoch);
  return epoch;
}
