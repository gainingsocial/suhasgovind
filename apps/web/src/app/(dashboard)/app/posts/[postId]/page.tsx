import Link from 'next/link';

import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, ResourceId, Timestamp, statusPresentation } from '@/components/ui';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

export const metadata = { title: 'Post' };

/**
 * Post detail and timeline (plan §40, §60).
 *
 * The timeline is the reason this page exists. A status badge says a post failed; the
 * timeline says which provider, on which attempt, after how long, and with what error —
 * which is the difference between a support ticket and a fix.
 */

interface PostTarget {
  id: string;
  destination_id: string;
  provider: string;
  status: string;
  external_post_id: string | null;
  external_url: string | null;
  published_at: string | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  next_attempt_at: string | null;
}

interface Post {
  id: string;
  status: string;
  content: { text?: string | null; media_ids?: string[]; link_url?: string | null };
  publish_at: string | null;
  targets: PostTarget[];
  created_at: string;
}

interface TimelineEvent {
  at: string;
  type: string;
  message: string;
  target_id: string | null;
  provider: string | null;
  error_code: string | null;
  attempt: number | null;
  duration_ms: number | null;
}

interface Timeline {
  post_id: string;
  status: string;
  events: TimelineEvent[];
}

export default async function PostDetailPage({
  params,
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;

  let context;
  let post: Post;
  let timeline: Timeline;

  try {
    context = await dashboardContext();
    // Fetched together: the timeline is the point of the page, so waiting for the post
    // first and then the timeline would double the time before anything renders.
    [post, timeline] = await Promise.all([
      sessionFetch<Post>(context, `/v1/posts/${postId}`),
      sessionFetch<Timeline>(context, `/v1/posts/${postId}/timeline`),
    ]);
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const presentation = statusPresentation(post.status);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/app/posts" className="text-xs text-[var(--text-subtle)] hover:underline">
            ← All posts
          </Link>
          <h1 className="mt-1 truncate font-mono text-lg font-semibold tracking-tight">{post.id}</h1>
          <p className="mt-1 text-sm text-[var(--text-subtle)]">
            Created <Timestamp iso={post.created_at} />
            {post.publish_at ? (
              <>
                {' '}
                · scheduled for <Timestamp iso={post.publish_at} relative={false} />
              </>
            ) : null}
          </p>
        </div>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
      </header>

      <Card>
        <CardHeader title="Content" />
        <div className="px-4 py-4 sm:px-5">
          {post.content.text ? (
            // `whitespace-pre-wrap` so the line breaks a person actually typed survive.
            // Collapsing them shows something other than what was published.
            <p className="text-sm whitespace-pre-wrap">{post.content.text}</p>
          ) : (
            <p className="text-sm text-[var(--text-subtle)]">No text.</p>
          )}
          {post.content.link_url ? (
            <p className="mt-2 text-sm">
              <a
                href={post.content.link_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {post.content.link_url}
              </a>
            </p>
          ) : null}
          {post.content.media_ids && post.content.media_ids.length > 0 ? (
            <p className="mt-2 text-xs text-[var(--text-subtle)]">
              {post.content.media_ids.length} media attachment
              {post.content.media_ids.length === 1 ? '' : 's'}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Destinations" description="Each one publishes independently" />
        <ul className="divide-y">
          {post.targets.map((target) => {
            const targetPresentation = statusPresentation(target.status);
            return (
              <li key={target.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{target.provider.replaceAll('_', ' ')}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {target.attempt_count} attempt{target.attempt_count === 1 ? '' : 's'}
                      {target.published_at ? (
                        <>
                          {' '}
                          · published <Timestamp iso={target.published_at} />
                        </>
                      ) : null}
                      {target.next_attempt_at ? (
                        <>
                          {' '}
                          · next try <Timestamp iso={target.next_attempt_at} />
                        </>
                      ) : null}
                    </p>
                    {/* The normalized code first, then the message. An integrator branches
                        on the code; a person reads the message. */}
                    {target.error_code ? (
                      <p className="mt-1 text-xs text-fail-600">
                        <span className="font-mono">{target.error_code}</span>
                        {target.error_message ? ` — ${target.error_message}` : ''}
                      </p>
                    ) : null}
                    {target.external_url ? (
                      <p className="mt-1 text-xs">
                        <a
                          href={target.external_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          View on {target.provider.replaceAll('_', ' ')}
                        </a>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={targetPresentation.tone}>{targetPresentation.label}</Badge>
                    <ResourceId id={target.id} label="Target id" />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Timeline"
          description="Every state change, in the order it happened"
        />
        <ol className="divide-y">
          {timeline.events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="flex gap-3 px-4 py-2.5 sm:px-5">
              {/* Fixed-width monospace time so the column does not jitter row to row. */}
              <span className="shrink-0 font-mono text-xs text-[var(--text-subtle)] tabular-nums">
                {event.at.slice(11, 19)}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm ${
                    event.type === 'target.failed' ? 'text-fail-600' : ''
                  }`}
                >
                  {event.message}
                </span>
                {event.duration_ms !== null || event.error_code ? (
                  <span className="mt-0.5 block text-xs text-[var(--text-subtle)]">
                    {event.error_code ? <span className="font-mono">{event.error_code}</span> : null}
                    {event.error_code && event.duration_ms !== null ? ' · ' : ''}
                    {event.duration_ms !== null ? `${event.duration_ms} ms` : null}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
