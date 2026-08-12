import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Logs' };

/**
 * The logs view (plan §60).
 *
 * §60 states the bar as a question a developer must be able to answer:
 *
 * > "Why did customer 847's Instagram Reel fail?"
 *
 * So this page is organized around that question rather than around a log stream. It leads
 * with what is currently wrong — failed posts and unhealthy connections — because a stream
 * makes somebody hunt, and by the time they are here they already know something is broken.
 */

interface PostSummary {
  id: string;
  status: string;
  profile_id: string;
  content: { text: string };
  target_count: number;
  published_target_count: number;
  created_at: string;
  request_id: string;
  trace_id: string;
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  health_detail: string | null;
  health_checked_at: string | null;
  provider_account_name: string | null;
}

interface ProviderHealth {
  provider: string;
  status: string;
  success_rate: number | null;
  attempts: number;
  last_error_code: string | null;
}

const emptyList = { object: 'list' as const, data: [], has_more: false, next_cursor: null };

export default async function LogsPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  /**
   * Three panels, fetched together and degraded independently.
   *
   * One failing endpoint must not replace the page with an error screen — the other two
   * still carry the information somebody came for, and an outage on one is not an outage
   * on all of them.
   */
  const [failed, connections, providers] = await Promise.all([
    sessionFetchOr<ListResponse<PostSummary>>(context, '/v1/posts?status=failed&limit=20', emptyList),
    sessionFetchOr<ListResponse<Connection>>(context, '/v1/connections?limit=50', emptyList),
    sessionFetchOr<{ object: 'list'; window_hours: number; data: ProviderHealth[] }>(
      context,
      '/v1/provider-health',
      { object: 'list', window_hours: 24, data: [] },
    ),
  ]);

  const unhealthy = connections.data.filter((connection) => connection.health !== 'healthy');
  const struggling = providers.data.filter(
    (provider) => provider.status === 'failing' || provider.status === 'degraded',
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Logs</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          What is currently wrong, and enough detail to say why. Every post has a full
          attempt timeline behind it.
        </p>
      </header>

      {/*
        Provider status first. It answers "is this us or them?" — and somebody who reads
        their own post as broken when the platform is down will spend the next hour
        rewriting content that was always fine.
      */}
      <Card>
        <CardHeader
          title="Platform status"
          description={`Success rates over the last ${providers.window_hours} hours, in this environment`}
        />
        {struggling.length === 0 ? (
          <EmptyState
            title="Every platform looks normal"
            description="No platform is failing or degraded for your recent publishing."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {struggling.map((provider) => (
              <li key={provider.provider} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{provider.provider}</p>
                  <p className="text-xs text-[var(--text-subtle)]">
                    {provider.attempts} attempts
                    {provider.success_rate !== null &&
                      ` · ${Math.round(provider.success_rate * 100)}% succeeded`}
                    {provider.last_error_code && ` · last error ${provider.last_error_code}`}
                  </p>
                </div>
                <Badge tone={provider.status === 'failing' ? 'fail' : 'warn'}>
                  {provider.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Connections needing attention"
          description="A connection that is not healthy cannot publish, and the reason says what to do"
        />
        {unhealthy.length === 0 ? (
          <EmptyState
            title="Every connection is healthy"
            description="Nothing needs reconnecting."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {unhealthy.map((connection) => (
              <li key={connection.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {connection.provider_account_name ?? connection.id}
                      <span className="ml-2 text-xs text-[var(--text-subtle)]">
                        {connection.provider}
                      </span>
                    </p>
                    {/*
                      The reason, not just the state. "reauth_required" tells somebody
                      nothing they can act on; "the refresh token expired" tells them to
                      reconnect and why it will not happen again tomorrow.
                    */}
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {connection.health_detail ?? 'No further detail recorded.'}
                    </p>
                  </div>
                  <Badge tone="warn">{connection.health}</Badge>
                </div>
                {connection.health_checked_at && (
                  <p className="mt-1 text-xs text-[var(--text-subtle)]">
                    Last checked <Timestamp iso={connection.health_checked_at} relative />
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Failed posts"
          description="Open one to see every attempt, with the normalized error code and what to do"
        />
        {failed.data.length === 0 ? (
          <EmptyState title="No failed posts" description="Nothing has failed recently." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {failed.data.map((post) => (
              <li key={post.id} className="px-4 py-3">
                <a href={`/app/posts/${post.id}`} className="block hover:underline">
                  <p className="truncate text-sm font-medium">
                    {post.content.text || '(no text)'}
                  </p>
                </a>
                <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                  {post.published_target_count} of {post.target_count} networks published ·{' '}
                  <Timestamp iso={post.created_at} relative />
                </p>
                {/*
                  Surfaced rather than hidden in a detail view. These are the two strings
                  that make a support conversation short, and nobody thinks to go and find
                  them when they are three clicks away.
                */}
                <p className="mt-1 font-mono text-[11px] text-[var(--text-subtle)]">
                  {post.request_id} · {post.trace_id}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
