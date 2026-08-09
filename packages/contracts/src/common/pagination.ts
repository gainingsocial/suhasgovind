import { z } from 'zod';

/**
 * Cursor pagination (plan §13).
 *
 * Cursor, not offset. Public IDs are UUIDv7, so they sort by creation time — which means
 * the cursor is just the last id seen, and a row inserted mid-pagination cannot shift a
 * page boundary and cause a caller to skip or repeat an item. Offset pagination over a
 * table that is actively being written to does exactly that, and publishing tables are
 * written to constantly.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const PaginationQuerySchema = z.object({
  /** Public id of the last item on the previous page. Exclusive. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** Newest-first by default: the most recent post is what a dashboard opens on. */
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * Build a list envelope schema for a given item schema.
 *
 * `has_more` is computed by over-fetching one row rather than issuing a COUNT: a count
 * over a large tenant-filtered table is far more expensive than one extra row, and
 * callers overwhelmingly want "is there another page", not "how many in total".
 */
export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    object: z.literal('list'),
    data: z.array(item),
    has_more: z.boolean(),
    /** Pass as `cursor` to fetch the next page. Null when `has_more` is false. */
    next_cursor: z.string().nullable(),
  });
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Trim an over-fetched result set to the requested size.
 *
 * The repository asks for `limit + 1` rows; this drops the sentinel and reports whether
 * it was there. Keeping the convention in one place stops a repository from returning
 * `limit + 1` items to a caller that trusted the limit.
 */
export function toPage<T>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
