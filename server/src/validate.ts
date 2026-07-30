import { z } from 'zod';

/**
 * User identifiers are normalized (trim + lowercase) BEFORE validation
 * and before they reach Redis, so "User@X.com " and "user@x.com" cannot
 * bypass the one-item-per-user rule as two distinct buyers.
 */
export const userIdSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, 'userId is required')
      .max(64, 'userId must be at most 64 characters')
      .regex(
        /^[a-z0-9._@+-]+$/,
        'userId may contain letters, numbers, and . _ @ + -',
      ),
  );

export const purchaseBodySchema = z.object({
  userId: userIdSchema,
});
