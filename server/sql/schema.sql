-- Durable system of record for the flash sale (v2), and the fallback
-- decider's own state (v3). Idempotent DDL: safe to run on every
-- `npm run migrate`.

-- One row per seeded sale. Makes Postgres sufficient to rebuild Redis
-- (rebuild needs initial stock + window, not just the winners).
-- `remaining` is the live counter the v3 Postgres allocator decrements
-- when Postgres is the decider; the redis path does not touch it.
CREATE TABLE IF NOT EXISTS sales (
  sale_id       text        PRIMARY KEY,
  initial_stock integer     NOT NULL CHECK (initial_stock > 0),
  remaining     integer,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  seeded_at     timestamptz NOT NULL DEFAULT now()
);

-- Which store decides purchases right now (v3). Exactly one decider at a
-- time is THE v3 invariant; every transition rule exists to keep it true.
-- epoch increments on each failback to a freshly rebuilt Redis, so an API
-- instance still talking to a discarded old Redis can be fenced out.
CREATE TABLE IF NOT EXISTS control (
  sale_id    text        PRIMARY KEY,
  allocator  text        NOT NULL DEFAULT 'redis'
             CHECK (allocator IN ('redis', 'postgres', 'cutover')),
  epoch      integer     NOT NULL DEFAULT 1,
  flipped_at timestamptz NOT NULL DEFAULT now()
);

-- One row per confirmed win, written by the write-behind consumer.
-- UNIQUE(sale_id, user_id) is the idempotency anchor: redelivered stream
-- entries no-op via ON CONFLICT DO NOTHING instead of duplicating orders.
-- Deliberately no FK to sales (tests use ad-hoc sale ids) and no unique on
-- stream_id (a second unique target would break the ON CONFLICT no-op).
CREATE TABLE IF NOT EXISTS orders (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id    text        NOT NULL,
  user_id    text        NOT NULL,
  stream_id  text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_one_per_user UNIQUE (sale_id, user_id)
);

-- v2 → v3 upgrade path for `sales.remaining`: add the column to existing
-- databases, backfill from what the durable store already knows (initial
-- minus orders won), then lock the invariants in. Sits AFTER the orders
-- table so the backfill works on a fresh database too. Each statement
-- no-ops on re-run.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS remaining integer;
UPDATE sales
   SET remaining = initial_stock -
       (SELECT count(*) FROM orders o WHERE o.sale_id = sales.sale_id)
 WHERE remaining IS NULL;
ALTER TABLE sales ALTER COLUMN remaining SET NOT NULL;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_remaining_nonneg;
ALTER TABLE sales ADD CONSTRAINT sales_remaining_nonneg
  CHECK (remaining >= 0);
