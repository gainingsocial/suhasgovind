import { z } from 'zod';

/**
 * Usage reporting (plan §70).
 *
 * Summed from the immutable usage-event log rather than from rolled-up counters, because
 * this is the number an invoice is built from and a customer reconciles against.
 */
export const UsageResponseSchema = z
  .object({
    object: z.literal('usage'),
    /** UTC date, `YYYY-MM-DD`, inclusive. */
    from: z.string(),
    to: z.string(),
    /** One entry per metric that saw activity. Metrics with no usage are omitted. */
    totals: z
      .array(z.object({ metric: z.string(), quantity: z.number().int() }).strict())
      .readonly(),
    /**
     * Daily breakdown, populated only when a `metric` query parameter narrows the request.
     * Returning every metric per day would be a matrix nobody reads and a slow query.
     */
    daily: z.array(z.object({ date: z.string(), quantity: z.number().int() }).strict()).readonly(),
  })
  .strict();

export type UsageResponse = z.infer<typeof UsageResponseSchema>;
