import type { PgPool } from '../pg.js';
import type { PurchaseOutcome } from '../redis.js';

/**
 * The Postgres twin of purchase.lua: decides a purchase entirely inside
 * one transaction, with the same outcomes the Lua script produces.
 *
 * Why this cannot oversell: every buyer's transaction must pass through
 * `UPDATE … SET remaining = remaining - 1 WHERE remaining > 0`. Postgres
 * row-locks the sales row on UPDATE, so concurrent buyers queue there and
 * each one re-evaluates `remaining > 0` against the previous winner's
 * committed value — the check and the decrement are one indivisible step,
 * exactly like the Lua script's DECR-after-guard.
 *
 * Lock order is identical in every transaction (orders unique index
 * first, then the sales row), so transactions can wait but never
 * deadlock.
 *
 * `epoch` is stamped into the order's stream_id slot as `pg:<epoch>` —
 * a Postgres-decided order has no Redis stream entry, and recording the
 * epoch instead says exactly which fallback window produced it.
 */
export async function purchaseViaPostgres(
  pool: PgPool,
  saleId: string,
  userId: string,
  epoch: number,
): Promise<PurchaseOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Dedupe first, mirroring the Lua script's SISMEMBER-first order: a
    // repeat buyer must be answered before any stock is touched.
    const inserted = await client.query(
      `INSERT INTO orders (sale_id, user_id, stream_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (sale_id, user_id) DO NOTHING`,
      [saleId, userId, `pg:${epoch}`],
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'ALREADY_PURCHASED';
    }

    const decremented = await client.query(
      `UPDATE sales
          SET remaining = remaining - 1
        WHERE sale_id = $1 AND remaining > 0`,
      [saleId],
    );
    if (decremented.rowCount === 0) {
      // Roll back so the loser's order row never survives, THEN look at
      // why: no sales row at all is an operator error, not a sell-out.
      await client.query('ROLLBACK');
      const sale = await client.query(
        'SELECT 1 FROM sales WHERE sale_id = $1',
        [saleId],
      );
      return sale.rowCount === 0 ? 'NOT_INITIALIZED' : 'SOLD_OUT';
    }

    await client.query('COMMIT');
    return 'PURCHASED';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
