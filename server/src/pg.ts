import pg from 'pg';

// pg is CommonJS; default-import + destructure is the shape that works
// under NodeNext + verbatimModuleSyntax.
const { Pool } = pg;

export type PgPool = pg.Pool;

export interface OrderRow {
  sale_id: string;
  user_id: string;
  stream_id: string;
}

export function createPgPool(databaseUrl: string): PgPool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
