import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SALE_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default('default'),
  // Explicit window (optional). When omitted, the seed script starts the
  // sale immediately and runs it for SALE_DURATION_MINUTES.
  SALE_START: z.coerce.date().optional(),
  SALE_END: z.coerce.date().optional(),
  SALE_DURATION_MINUTES: z.coerce.number().int().positive().default(10),
  INITIAL_STOCK: z.coerce.number().int().positive(),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://flash:flash@localhost:5432/flashsale'),
  CONSUMER_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default('consumer-1'),
  CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  CONSUMER_BLOCK_MS: z.coerce.number().int().nonnegative().default(5000),
  // Turns the Postgres fallback on or off. On (default) is the real system:
  // Redis decides, Postgres remembers and takes over when Redis dies. Off
  // runs the server Redis-only — no durability, no failover — a kill-switch
  // for when Postgres itself is the thing misbehaving.
  FALLBACK: z.enum(['on', 'off']).default('on'),
});

export interface AppConfig {
  port: number;
  redisUrl: string;
  saleId: string;
  initialStock: number;
  saleDurationMs: number;
  explicitWindow: { startsAt: Date; endsAt: Date } | null;
  databaseUrl: string;
  fallbackEnabled: boolean;
  consumer: { name: string; batchSize: number; blockMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const d = parsed.data;
  if ((d.SALE_START === undefined) !== (d.SALE_END === undefined)) {
    throw new Error(
      'Invalid environment: SALE_START and SALE_END must be set together',
    );
  }
  if (d.SALE_START && d.SALE_END && d.SALE_END <= d.SALE_START) {
    throw new Error('Invalid environment: SALE_END must be after SALE_START');
  }
  return {
    port: d.PORT,
    redisUrl: d.REDIS_URL,
    saleId: d.SALE_ID,
    initialStock: d.INITIAL_STOCK,
    saleDurationMs: d.SALE_DURATION_MINUTES * 60_000,
    explicitWindow:
      d.SALE_START && d.SALE_END
        ? { startsAt: d.SALE_START, endsAt: d.SALE_END }
        : null,
    databaseUrl: d.DATABASE_URL,
    fallbackEnabled: d.FALLBACK === 'on',
    consumer: {
      name: d.CONSUMER_NAME,
      batchSize: d.CONSUMER_BATCH_SIZE,
      blockMs: d.CONSUMER_BLOCK_MS,
    },
  };
}
