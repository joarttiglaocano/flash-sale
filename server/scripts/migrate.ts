import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createPgPool } from '../src/pg.js';

const config = loadConfig();
const schema = readFileSync(
  new URL('../sql/schema.sql', import.meta.url),
  'utf8',
);

const pool = createPgPool(config.databaseUrl);
await pool.query(schema);
console.log('Migration applied: sales + orders + control tables ready.');
await pool.end();
