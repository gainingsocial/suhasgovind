import Link from 'next/link';

import { renderLoadFailure } from '@/components/page-states';
import { Badge, Button, Card, CardHeader, EmptyState, Timestamp, statusPresentation } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Overview' };

/**
 * Overview (plan §54).
 *
 * The question this page answers is "is anything wrong right now" — not "how many posts
 * have I ever made". Vanity totals push the one broken connection below the fold, so
 * health comes first and counts come second.
 */

interface PostSummary {
  id: string;
  status: string;
  created_at: string;
  target_count: number;
  published_target_count: number;
}

interface ConnectionSummary {
  id: string;
  provider: string;
  provider_account_name: string | null;
  health: string;
  setup_completed_at: string | null;
}

export default async function OverviewPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  // Fetched together rather than in sequence. Three round trips to the API from a server
  // render is three times the latency for no benefit — none of these depends on another.
  const [posts, connections] = await Promise.all([
    sessionFetchOr<ListResponse<PostSummary>>(context, '/v1/posts?limit=5&order=desc', {
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    }),
    sessionFetchOr<ListResponse<ConnectionSummary>>(context, '/v1/connections?limit=25', {
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    }),
  ]);

  const unhealthy = connections.data.filter(
    (connection) => connection.health !== 'healthy' && connection.health !== 'refresh_due',
  );
  const incomplete = connections.data.filter((connection) => connection.setup_completed_at === null);

  const needsAttention =
    unhealthy.length +
    incomplete.length +
    posts.data.filter((post) => post.status === 'failed' || post.status === 'partially_published')
      .length;

  const setupSteps = {
    profile: connections.data.length > 0,
    connection: connections.data.some((connection) => connection.setup_completed_at !== null),
    post: posts.data.length > 0,
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Overview</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Publishing health across every connected account.
        </p>
      </header>

      {/* Hidden once the path is walked. A permanent checklist on a working account is
          clutter that pushes the thing that matters down the page. */}
      {setupSteps.post ? null : <GettingStarted done={setupSteps} />}

      {/* Single column on phones, two up from sm, four from lg. Stat tiles side by side
          on a 360px screen become unreadable slivers. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Recent posts"
          value={String(posts.data.length)}
          hint="Newest five"
        />
        <Stat
          label="Scheduled"
          value={String(posts.data.filter((post) => post.status === 'scheduled').length)}
          hint="Waiting to go out"
        />
        <Stat
          label="Needs attention"
          value={String(needsAttention)}
          hint="Failed, blocked or unfinished"
          tone={needsAttention > 0 ? 'fail' : undefined}
        />
        <Stat
          label="Connections"
          value={String(connections.data.length - unhealthy.length)}
          hint={`${connections.data.length} total`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Recent posts"
            description="Newest first"
            action={
              <Button variant="ghost" className="text-xs" aria-label="View all posts">
                <Link href="/app/posts">View all</Link>
              </Button>
            }
          />
          {posts.data.length === 0 ? (
            <EmptyState
              title="No posts yet"
              description="Create your first post and it will appear here with its status on every destination."
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
                  <li key={post.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <span className="min-w-0">
                      <Link
                        href={`/app/posts/${post.id}` as never}
                        className="block truncate font-mono text-xs hover:underline"
                      >
                        {post.id}
                      </Link>
                      <span className="mt-0.5 block text-xs text-[var(--text-subtle)]">
                        <Timestamp iso={post.created_at} /> ·{' '}
                        {post.published_target_count}/{post.target_count} published
                      </span>
                    </span>
                    <Badge tone={presentation.tone}>{presentation.label}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Connection health" description="Accounts that can publish" />
          {connections.data.length === 0 ? (
            <EmptyState
              title="No accounts connected"
              description="Connect a social account to a profile before you can publish to it."
              action={
                <Link
                  href="/app/connections"
                  className="inline-flex min-h-9 items-center rounded-lg border px-3 text-sm font-medium"
                >
                  Connect an account
                </Link>
              }
            />
          ) : (
            <ul className="divide-y">
              {/* Unhealthy first. A list sorted by connection date buries the one broken
                  account under nine working ones, which is the opposite of the job. */}
              {[...connections.data]
                .sort((a, b) => healthRank(a) - healthRank(b))
                .slice(0, 6)
                .map((connection) => {
                  const presentation = statusPresentation(connection.health);
                  return (
                    <li
                      key={connection.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {connection.provider_account_name ?? connection.provider}
                        </span>
                        <span className="block text-xs text-[var(--text-subtle)]">
                          {connection.provider.replaceAll('_', ' ')}
                          {connection.setup_completed_at === null ? ' · needs a destination' : ''}
                        </span>
                      </span>
                      <Badge tone={connection.setup_completed_at === null ? 'warn' : presentation.tone}>
                        {connection.setup_completed_at === null ? 'Unfinished' : presentation.label}
                      </Badge>
                    </li>
                  );
                })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Broken first, unfinished next, healthy last. */
function healthRank(connection: ConnectionSummary): number {
  if (connection.health !== 'healthy' && connection.health !== 'refresh_due') return 0;
  if (connection.setup_completed_at === null) return 1;
  return 2;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'fail';
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-[var(--text-subtle)]">{label}</p>
      {/* Tabular figures stop the number jittering horizontally as it updates. */}
      <p
        className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone === 'fail' ? 'text-fail-600' : ''}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-[var(--text-subtle)]">{hint}</p>
    </Card>
  );
}

/**
 * Onboarding path (plan §52.1).
 *
 * Steps tick off as they are actually completed, read from live state rather than from a
 * flag somebody has to remember to set. The order matches the only order that works: a
 * key, then a profile, then a connection, then a post.
 */
function GettingStarted({
  done,
}: {
  done: { profile: boolean; connection: boolean; post: boolean };
}) {
  const steps = [
    {
      title: 'Create an API key',
      body: 'Authenticates every request. Test keys never touch live accounts.',
      href: '/app/keys',
      // Signing in proves a key can be created; whether one exists is a separate call
      // this page deliberately does not make just to tick a box.
      complete: false,
    },
    {
      title: 'Add a profile',
      body: 'A profile is the brand or customer you publish on behalf of.',
      href: '/app/profiles',
      complete: done.profile,
    },
    {
      title: 'Connect an account',
      body: 'Link a social account so there is somewhere to publish.',
      href: '/app/connections',
      complete: done.connection,
    },
    {
      title: 'Publish',
      body: 'Compose once, send to every destination you selected.',
      href: '/app/compose',
      complete: done.post,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Get started"
        description="Four steps to your first published post"
        action={<Badge tone="brand">Setup</Badge>}
      />
      <ol className="divide-y">
        {steps.map((step, index) => (
          <li key={step.href}>
            <Link
              href={step.href as never}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-sunken)] sm:px-5"
            >
              <span
                className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-medium ${
                  step.complete
                    ? 'border-ok-600 bg-ok-600 text-white'
                    : 'text-[var(--text-subtle)]'
                }`}
                aria-hidden="true"
              >
                {step.complete ? '✓' : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{step.title}</span>
                <span className="mt-0.5 block text-sm text-[var(--text-subtle)]">{step.body}</span>
              </span>
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" className="mt-1 shrink-0 text-[var(--text-subtle)]" aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
