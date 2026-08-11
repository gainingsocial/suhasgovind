import Link from 'next/link';

import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp, statusPresentation } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Posts' };

/**
 * Post list (plan §60).
 *
 * Every row shows how many destinations actually published, not a single rolled-up
 * verdict. Plan §61 is explicit that a failed target must never hide behind an aggregate —
 * "partly published" with three green and one red is the whole point of a multi-target
 * publisher, and a green tick on that row would be a lie.
 */

interface PostSummary {
  id: string;
  status: string;
  profile_id: string;
  publish_at: string | null;
  target_count: number;
  published_target_count: number;
  created_at: string;
}

export default async function PostsPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const posts = await sessionFetchOr<ListResponse<PostSummary>>(
    context,
    '/v1/posts?limit=50&order=desc',
    { object: 'list', data: [], has_more: false, next_cursor: null },
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Posts</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Everything you have published, scheduled or attempted.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge tone="ok">Published</Badge>
          <Badge tone="warn">Partly</Badge>
          <Badge tone="fail">Failed</Badge>
        </div>
      </header>

      <Card>
        <CardHeader
          title="All posts"
          description={posts.data.length > 0 ? 'Newest first' : undefined}
        />
        {posts.data.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description="Posts appear the moment they are accepted, with live status for each destination."
            action={
              <Link
                href="/app/compose"
                className="inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-3 text-sm font-medium text-[var(--on-brand)]"
              >
                Compose a post
              </Link>
            }
          />
        ) : (
          <ul className="divide-y">
            {posts.data.map((post) => {
              const presentation = statusPresentation(post.status);
              return (
                <li key={post.id}>
                  <Link
                    href={`/app/posts/${post.id}` as never}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-sunken)] sm:px-5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{post.id}</span>
                      <span className="mt-0.5 block text-xs text-[var(--text-subtle)]">
                        {post.published_target_count}/{post.target_count} destination
                        {post.target_count === 1 ? '' : 's'} ·{' '}
                        {post.publish_at ? (
                          <>
                            scheduled <Timestamp iso={post.publish_at} />
                          </>
                        ) : (
                          <>
                            created <Timestamp iso={post.created_at} />
                          </>
                        )}
                      </span>
                    </span>
                    <Badge tone={presentation.tone}>{presentation.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
