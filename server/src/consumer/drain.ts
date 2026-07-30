import type { PgPool } from '../pg.js';
import { WINS_GROUP, type SaleRedis } from '../redis.js';

export interface WinEntry {
  streamId: string;
  userId: string;
  saleId: string;
}

export interface DrainDeps {
  redis: SaleRedis;
  pool: PgPool;
  winsKey: string;
  consumerName: string;
  batchSize: number;
  blockMs: number;
}

// ioredis returns XREADGROUP replies as nested arrays with FLAT field
// lists: [[streamKey, [[id, ['userId','alice','saleId','s1']], …]]].
// This is the single place that shape is interpreted.
type XReadGroupReply = [string, [string, string[] | null][]][] | null;

export function parseStreamReply(reply: unknown): WinEntry[] {
  const streams = reply as XReadGroupReply;
  if (!streams) return [];
  const entries: WinEntry[] = [];
  for (const [, items] of streams) {
    for (const [streamId, fields] of items) {
      // fields is null for pending entries whose data was deleted from the
      // stream; they carry nothing to persist but must still be acked.
      const record: Record<string, string> = {};
      if (fields) {
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const name = fields[i];
          const value = fields[i + 1];
          if (name !== undefined && value !== undefined) record[name] = value;
        }
      }
      entries.push({
        streamId,
        userId: record.userId ?? '',
        saleId: record.saleId ?? '',
      });
    }
  }
  return entries;
}

/**
 * id '>' reads entries never delivered to this group (blocking up to
 * blockMs); id '0' re-reads this consumer's own pending entries — used on
 * startup to recover work read but not acked before a crash.
 */
export async function readBatch(
  deps: DrainDeps,
  id: '0' | '>',
): Promise<WinEntry[]> {
  const reply = await deps.redis.xreadgroup(
    'GROUP',
    WINS_GROUP,
    deps.consumerName,
    'COUNT',
    deps.batchSize,
    'BLOCK',
    deps.blockMs,
    'STREAMS',
    deps.winsKey,
    id,
  );
  return parseStreamReply(reply);
}

/**
 * One multi-row INSERT = one implicit transaction: the whole batch commits
 * or none of it does. ON CONFLICT (sale_id, user_id) DO NOTHING makes
 * redelivered entries no-ops, which is what turns at-least-once delivery
 * into exactly-once effect. Returns rows actually inserted.
 */
export async function persistBatch(
  pool: PgPool,
  entries: WinEntry[],
): Promise<number> {
  const rows = entries.filter((e) => e.userId !== '' && e.saleId !== '');
  if (rows.length === 0) return 0;
  const placeholders = rows
    .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
    .join(', ');
  const params = rows.flatMap((e) => [e.saleId, e.userId, e.streamId]);
  const result = await pool.query(
    `INSERT INTO orders (sale_id, user_id, stream_id)
     VALUES ${placeholders}
     ON CONFLICT (sale_id, user_id) DO NOTHING`,
    params,
  );
  return result.rowCount ?? 0;
}

/** Read a batch, persist it, then ack it. Returns entries processed. */
export async function drainOnce(
  deps: DrainDeps,
  id: '0' | '>' = '>',
): Promise<number> {
  const entries = await readBatch(deps, id);
  if (entries.length === 0) return 0;
  await persistBatch(deps.pool, entries);
  // Ack ONLY after the insert committed. A crash between the two leaves
  // the batch pending; the redelivery no-ops on the unique constraint.
  await deps.redis.xack(
    deps.winsKey,
    WINS_GROUP,
    ...entries.map((e) => e.streamId),
  );
  return entries.length;
}
