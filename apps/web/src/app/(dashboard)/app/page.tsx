import Link from 'next/link';

import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState, Timestamp, statusPresentation } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Today' };

/**
 * Today (creator plan §5.2, extending plan §54).
 *
 * The screen somebody opens every morning, in three bands and one order:
 *
 *   1. Needs you    — the only band that is ever urgent
 *   2. Going out    — the next day's work, so it can be caught before it ships
 *   3. Landed       — what happened while you were away
 *
 * The version this replaces led with four stat tiles. Counts are the wrong lead: a tile
 * reading "3" tells somebody to go hunting, while "Your Instagram account needs
 * reconnecting" tells them what to do. Where a number is genuinely the answer it stays, in
 * the third band, where nothing is waiting on it.
 *
 * **An empty screen is the goal.** If all three bands are quiet, this says so in one line
 * rather than filling the space with charts — a dashboard that shows twelve panels to
 * somebody with nothing to do has failed at its only job.
 */

interface PostSummary {
  id: string;
  status: string;
  created_at: string;
  publish_at: string | null;
  published_at: string | null;
  content: { text: string };
  target_count: number;
  published_target_count: number;
}

interface ConnectionSummary {
  id: string;
  provider: string;
  provider_account_name: string | null;
  health: string;
  health_detail: string | null;
  setup_completed_at: string | null;
}

interface Approval {
  id: string;
  summary: string | null;
  expires_at: string;
}

const emptyList = <T,>(): ListResponse<T> => ({
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
});

/** A post has no title, so the first line of what it says is the only honest label. */
function postLabel(post: PostSummary): string {
  const text = post.content?.text?.trim();
  if (!text) return 'A post with no text';
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

export default async function TodayPage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  // Fetched together rather than in sequence: none depends on another, and five sequential
  // round trips from a server render is five times the latency for no benefit.
  const [recent, failed, scheduled, connections, approvals] = await Promise.all([
    sessionFetchOr<ListResponse<PostSummary>>(context, '/v1/posts?limit=8&order=desc', emptyList<PostSummary>()),
    sessionFetchOr<ListResponse<PostSummary>>(context, '/v1/posts?status=failed&limit=10', emptyList<PostSummary>()),
    sessionFetchOr<ListResponse<PostSummary>>(context, '/v1/posts?status=scheduled&limit=25', emptyList<PostSummary>()),
    sessionFetchOr<ListResponse<ConnectionSummary>>(context, '/v1/connections?limit=50', emptyList<ConnectionSummary>()),
    sessionFetchOr<ListResponse<Approval>>(
      context,
      `/v1/approvals?environment_id=${context.environment.id}`,
      emptyList<Approval>(),
    ),
  ]);

  /**
   * `refresh_due` is deliberately not "needs you".
   *
   * A token approaching expiry is the connection-health worker's job, and it refreshes
   * ahead of time without anybody being told. Listing it here would train people to ignore
   * this band, which is the one thing it cannot survive.
   */
  const broken = connections.data.filter(
    (connection) => connection.health !== 'healthy' && connection.health !== 'refresh_due',
  );
  const unfinished = connections.data.filter((connection) => connection.setup_completed_at === null);

  const partial = recent.data.filter((post) => post.status === 'partially_published');

  const attention =
    failed.data.length + partial.length + broken.length + unfinished.length + approvals.data.length;

  // Sorted by when they go out, not when they were written — this band is a timeline.
  const upcoming = [...scheduled.data].sort((a, b) => {
    const left = a.publish_at ? Date.parse(a.publish_at) : Number.MAX_SAFE_INTEGER;
    const right = b.publish_at ? Date.parse(b.publish_at) : Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  const landed = recent.data.filter(
    (post) => post.status === 'published' || post.status === 'partially_published',
  );

  const nothingYet = recent.data.length === 0 && connections.data.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Today</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          {attention === 0
            ? 'Nothing needs you right now.'
            : `${attention} ${attention === 1 ? 'thing needs' : 'things need'} you.`}
        </p>
      </header>

      {nothingYet ? <GettingStarted /> : null}

      {/* ---- 1. Needs you ---------------------------------------------------- */}
      {attention > 0 ? (
        <Card>
          <CardHeader title="Needs you" description="Everything that is stuck, broken or waiting" />
          <ul className="divide-y divide-[var(--border)]">
            {approvals.data.map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {approval.summary ?? 'A post is waiting for your approval.'}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                    Expires <Timestamp iso={approval.expires_at} relative />
                  </p>
                </div>
                <Link href="/app/autopilot" className="text-sm font-medium underline">
                  Review
                </Link>
              </li>
            ))}

            {broken.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {connection.provider_account_name ?? connection.provider} needs reconnecting
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                    {connection.health_detail ?? statusPresentation(connection.health).label}
                  </p>
                </div>
                <Link href="/app/connections" className="text-sm font-medium underline">
                  Fix
                </Link>
              </li>
            ))}

            {unfinished.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {connection.provider_account_name ?? connection.provider} is not finished
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                    It connected, but no page or channel was chosen — so there is nowhere to publish.
                  </p>
                </div>
                <Link href="/app/connections" className="text-sm font-medium underline">
                  Finish
                </Link>
              </li>
            ))}

            {[...failed.data, ...partial].map((post) => (
              <li key={post.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{postLabel(post)}</p>
                  <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                    Reached {post.published_target_count} of {post.target_count} networks ·{' '}
                    <Timestamp iso={post.created_at} relative />
                  </p>
                </div>
                <Link href={`/app/posts/${post.id}` as never} className="text-sm font-medium underline">
                  See why
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ---- 2. Going out ---------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Going out"
          description={upcoming.length > 0 ? 'Scheduled, soonest first' : 'Nothing is scheduled'}
          action={
            <Link href="/app/compose" className="text-sm font-medium underline">
              Write something
            </Link>
          }
        />
        {upcoming.length === 0 ? (
          <EmptyState
            title="Nothing scheduled"
            description="Write a post and pick a time, and it waits here until it goes out."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {upcoming.slice(0, 10).map((post) => (
              <li key={post.id} className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <Link href={`/app/posts/${post.id}` as never} className="block truncate text-sm font-medium hover:underline">
                    {postLabel(post)}
                  </Link>
                  <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                    {post.publish_at ? <Timestamp iso={post.publish_at} relative /> : 'No time set'}
                    {' · '}
                    {post.target_count} {post.target_count === 1 ? 'network' : 'networks'}
                  </p>
                </div>
                <Badge tone="brand">Scheduled</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---- 3. Landed ------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Landed"
          description="Recently published"
          action={
            <Link href="/app/insights" className="text-sm font-medium underline">
              See how they did
            </Link>
          }
        />
        {landed.length === 0 ? (
          <EmptyState
            title="Nothing published yet"
            description="Your first published post shows up here, with how far it reached."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {landed.slice(0, 6).map((post) => {
              const presentation = statusPresentation(post.status);

              return (
                <li key={post.id} className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/app/posts/${post.id}` as never} className="block truncate text-sm font-medium hover:underline">
                      {postLabel(post)}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--text-subtle)]">
                      {post.published_at ? <Timestamp iso={post.published_at} relative /> : <Timestamp iso={post.created_at} relative />}
                      {' · '}
                      {post.published_target_count}/{post.target_count} networks
                    </p>
                  </div>
                  <Badge tone={presentation.tone}>{presentation.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The first-run path (creator plan C1: first post in under five minutes).
 *
 * Three steps, not four. The version this replaces opened with "create an API key", which
 * is the correct first step for an integrator and a wall for everybody else — somebody who
 * came to publish a post should not have to learn what a key is first. Keys still exist,
 * under Developer, where the people who need them will look.
 *
 * Shown only while genuinely empty. A permanent checklist on a working account is clutter
 * that pushes the real work down the page.
 */
function GettingStarted() {
  const steps = [
    {
      title: 'Connect an account',
      body: 'Bluesky, Telegram and Discord work straight away — no application, no waiting.',
      href: '/app/connections',
      cta: 'Connect',
    },
    {
      title: 'Write once',
      body: 'One piece of writing, adapted to each network. You see exactly what each will publish.',
      href: '/app/compose',
      cta: 'Write',
    },
    {
      title: 'Let it run',
      body: 'Point it at your blog or feed and new articles become posts on their own.',
      href: '/app/autopilot',
      cta: 'Set up',
    },
  ];

  return (
    <Card>
      <CardHeader title="Start here" description="Three steps to publishing on its own" />
      <ol className="divide-y divide-[var(--border)]">
        {steps.map((step, index) => (
          <li key={step.href}>
            <Link
              href={step.href as never}
              className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--surface-sunken)] sm:px-5"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-[var(--on-brand)]"
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{step.title}</span>
                <span className="mt-0.5 block text-sm text-[var(--text-subtle)]">{step.body}</span>
              </span>
              <span className="mt-0.5 shrink-0 text-sm font-medium text-[var(--brand-text)]">
                {step.cta}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
