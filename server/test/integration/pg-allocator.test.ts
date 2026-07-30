import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purchaseViaPostgres } from '../../src/allocator/postgres.js';
import { cleanupPg, connectPg, seedPgSale } from '../helpers.js';

/**
 * Postgres as the SOLE decider. No Redis anywhere in this
 * file — every decision is the allocator's transaction, and the money
 * test proves it cannot oversell under genuine concurrency.
 */
describe('postgres allocator', () => {
  const pool = connectPg();
  let saleId: string;

  beforeEach(() => {
    saleId = `test-${randomUUID()}`;
  });

  afterEach(async () => {
    await cleanupPg(pool, saleId);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('outcome semantics', () => {
    it('first purchase wins, decrements remaining, records the epoch', async () => {
      await seedPgSale(pool, saleId, 5);

      const outcome = await purchaseViaPostgres(pool, saleId, 'alice', 1);
      expect(outcome).toBe('PURCHASED');

      const order = await pool.query(
        'SELECT stream_id FROM orders WHERE sale_id = $1 AND user_id = $2',
        [saleId, 'alice'],
      );
      expect(order.rows[0]?.stream_id).toBe('pg:1');

      const sale = await pool.query(
        'SELECT remaining FROM sales WHERE sale_id = $1',
        [saleId],
      );
      expect(sale.rows[0]?.remaining).toBe(4);
    });

    it('repeat buyer gets ALREADY_PURCHASED and burns no stock', async () => {
      await seedPgSale(pool, saleId, 5);

      await purchaseViaPostgres(pool, saleId, 'alice', 1);
      const outcome = await purchaseViaPostgres(pool, saleId, 'alice', 1);
      expect(outcome).toBe('ALREADY_PURCHASED');

      const sale = await pool.query(
        'SELECT remaining FROM sales WHERE sale_id = $1',
        [saleId],
      );
      expect(sale.rows[0]?.remaining).toBe(4);
    });

    it('SOLD_OUT once remaining hits zero, and the loser leaves no order row', async () => {
      await seedPgSale(pool, saleId, 1);

      expect(await purchaseViaPostgres(pool, saleId, 'alice', 1)).toBe(
        'PURCHASED',
      );
      expect(await purchaseViaPostgres(pool, saleId, 'bob', 1)).toBe(
        'SOLD_OUT',
      );

      const orders = await pool.query(
        'SELECT user_id FROM orders WHERE sale_id = $1',
        [saleId],
      );
      expect(orders.rows).toEqual([{ user_id: 'alice' }]);
    });

    it('NOT_INITIALIZED for a sale that was never seeded, no order row survives', async () => {
      const outcome = await purchaseViaPostgres(pool, saleId, 'alice', 1);
      expect(outcome).toBe('NOT_INITIALIZED');

      const orders = await pool.query(
        'SELECT 1 FROM orders WHERE sale_id = $1',
        [saleId],
      );
      expect(orders.rowCount).toBe(0);
    });
  });

  describe('concurrency correctness (the money test, against postgres alone)', () => {
    const STOCK = 25;
    const USERS = 100;
    const ATTEMPTS_PER_USER = 5;

    it(`${USERS} users × ${ATTEMPTS_PER_USER} simultaneous attempts → exactly ${STOCK} purchases`, async () => {
      await seedPgSale(pool, saleId, STOCK);

      const attempts = Array.from(
        { length: USERS * ATTEMPTS_PER_USER },
        (_, i) => `user-${i % USERS}`,
      );
      const outcomes = await Promise.all(
        attempts.map((userId) =>
          purchaseViaPostgres(pool, saleId, userId, 1),
        ),
      );

      const byCode = new Map<string, number>();
      for (const outcome of outcomes) {
        byCode.set(outcome, (byCode.get(outcome) ?? 0) + 1);
      }
      expect(byCode.get('PURCHASED')).toBe(STOCK);
      expect(
        (byCode.get('ALREADY_PURCHASED') ?? 0) + (byCode.get('SOLD_OUT') ?? 0),
      ).toBe(USERS * ATTEMPTS_PER_USER - STOCK);
      expect(byCode.get('NOT_INITIALIZED') ?? 0).toBe(0);

      const sale = await pool.query(
        'SELECT remaining FROM sales WHERE sale_id = $1',
        [saleId],
      );
      expect(sale.rows[0]?.remaining).toBe(0);

      const orders = await pool.query(
        'SELECT DISTINCT user_id FROM orders WHERE sale_id = $1',
        [saleId],
      );
      expect(orders.rowCount).toBe(STOCK);
    }, 30_000);

    it('remaining never goes negative even with more winners than items', async () => {
      await seedPgSale(pool, saleId, STOCK);

      await Promise.all(
        Array.from({ length: USERS }, (_, i) =>
          purchaseViaPostgres(pool, saleId, `solo-${i}`, 1),
        ),
      );

      const sale = await pool.query(
        'SELECT remaining FROM sales WHERE sale_id = $1',
        [saleId],
      );
      expect(sale.rows[0]?.remaining).toBe(0);

      const orders = await pool.query(
        'SELECT count(*)::int AS n FROM orders WHERE sale_id = $1',
        [saleId],
      );
      expect(orders.rows[0]?.n).toBe(STOCK);
    }, 30_000);
  });

});
