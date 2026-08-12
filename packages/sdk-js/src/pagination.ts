/**
 * Cursor pagination helpers (plan §13).
 *
 * The API pages by cursor rather than offset because public ids are UUIDv7 and sort by
 * creation time, so a row written mid-pagination cannot shift a page boundary. That
 * property is worth nothing if every caller hand-rolls the loop and gets the terminating
 * condition wrong, which is what `autoPaginate` is for.
 */

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListParams {
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

/**
 * Walk every page as one async iterable.
 *
 * ```ts
 * for await (const post of gs.posts.autoList()) { ... }
 * ```
 *
 * Stops on `has_more: false` rather than on an empty page: a page can legitimately come
 * back empty when a filter excludes everything in that id range, and treating that as the
 * end silently truncates the result.
 */
export async function* autoPaginate<T>(
  fetchPage: (params: ListParams) => Promise<ListResponse<T>>,
  params: ListParams = {},
): AsyncGenerator<T, void, undefined> {
  let cursor = params.cursor;

  for (;;) {
    const page = await fetchPage({ ...params, ...(cursor ? { cursor } : {}) });

    for (const item of page.data) yield item;

    if (!page.has_more || !page.next_cursor) return;
    // A server that reports `has_more` without a cursor would loop forever; the check
    // above makes that a clean stop instead.
    cursor = page.next_cursor;
  }
}
