import type { PgPool } from '../pg.js';

export type Allocator = 'redis' | 'postgres' | 'cutover';

export interface ControlState {
  allocator: Allocator;
  epoch: number;
  flippedAt: Date;
}

interface ControlRow {
  allocator: Allocator;
  epoch: number;
  flipped_at: Date;
}

/** Current decider for the sale, or null when the sale was never seeded. */
export async function getControl(
  pool: PgPool,
  saleId: string,
): Promise<ControlState | null> {
  const result = await pool.query<ControlRow>(
    'SELECT allocator, epoch, flipped_at FROM control WHERE sale_id = $1',
    [saleId],
  );
  const row = result.rows[0];
  return row
    ? { allocator: row.allocator, epoch: row.epoch, flippedAt: row.flipped_at }
    : null;
}

/**
 * Flips the decider. The epoch increments ONLY when flipping back to
 * redis — that flip means "a freshly rebuilt Redis is now live", and the
 * new epoch is what fences out any API instance still talking to the old
 * discarded one. Fail-forward (→ postgres) and the cutover park keep the
 * current epoch: the durable store's identity never changed.
 */
export async function setAllocator(
  pool: PgPool,
  saleId: string,
  allocator: Allocator,
): Promise<ControlState> {
  const result = await pool.query<ControlRow>(
    `UPDATE control
        SET allocator = $2,
            epoch = epoch + CASE
              WHEN $2 = 'redis' AND allocator <> 'redis' THEN 1 ELSE 0 END,
            flipped_at = now()
      WHERE sale_id = $1
      RETURNING allocator, epoch, flipped_at`,
    [saleId, allocator],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `No control row for sale "${saleId}" — was the sale seeded?`,
    );
  }
  return {
    allocator: row.allocator,
    epoch: row.epoch,
    flippedAt: row.flipped_at,
  };
}

/**
 * Fail forward to Postgres AND reconcile its stock counter in one
 * atomic statement. While Redis is the decider it never touches `remaining`,
 * so by failover time that counter is stale-high; a cold fallback would
 * re-sell. Here we recompute `remaining = initial_stock - count(orders)` from
 * the durable orders (which the write-behind consumer keeps current) at the
 * instant we flip, so Postgres starts deciding from the true count.
 *
 * The residual gap is exactly the wins Redis decided that the consumer had
 * not yet drained into `orders` — bounded by drain lag, not by the whole of
 * Redis's sales. Closing it entirely would need a synchronous ack, which is
 * the throughput Redis exists to avoid. Epoch is unchanged (only failback to
 * redis bumps it).
 */
export async function failForwardToPostgres(
  pool: PgPool,
  saleId: string,
): Promise<ControlState> {
  const result = await pool.query<ControlRow>(
    `WITH recon AS (
       UPDATE sales
          SET remaining = initial_stock
              - (SELECT count(*) FROM orders o WHERE o.sale_id = $1)
        WHERE sale_id = $1
     )
     UPDATE control SET allocator = 'postgres', flipped_at = now()
      WHERE sale_id = $1
      RETURNING allocator, epoch, flipped_at`,
    [saleId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `No control row for sale "${saleId}" — was the sale seeded?`,
    );
  }
  return {
    allocator: row.allocator,
    epoch: row.epoch,
    flippedAt: row.flipped_at,
  };
}
