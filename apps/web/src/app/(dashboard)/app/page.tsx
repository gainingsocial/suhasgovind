import Link from 'next/link';

import { Badge, Button, Card, CardHeader, EmptyState } from '@/components/ui';

export const metadata = { title: 'Overview' };

/**
 * Overview (plan §54).
 *
 * The question this page answers is "is anything wrong right now" — not "how many posts
 * have I ever made". Vanity totals push the one broken connection below the fold, so
 * health comes first and counts come second.
 *
 * Renders from static content until an API key is configured. A dashboard that shows a
 * spinner before you have credentials is worse than one that tells you what to do.
 */
export default function OverviewPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Overview</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          Publishing health across every connected account.
        </p>
      </header>

      <GettingStarted />

      {/* Single column on phones, two up from sm, four from lg. Stat tiles side by side
          on a 360px screen become unreadable slivers. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Published today" value="—" hint="Across all destinations" />
        <Stat label="Scheduled" value="—" hint="Waiting to go out" />
        <Stat label="Needs attention" value="—" hint="Failed or blocked" tone="fail" />
        <Stat label="Connections" value="—" hint="Healthy accounts" />
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
        </Card>

        <Card>
          <CardHeader title="Connection health" description="Accounts that can publish" />
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
        </Card>
      </div>
    </div>
  );
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
 * Shown until the steps are done rather than hidden behind a docs link. The order matches
 * the only order that works: a key, then a profile, then a connection, then a post.
 */
function GettingStarted() {
  const steps = [
    { title: 'Create an API key', body: 'Authenticates every request. Test keys never touch live accounts.', href: '/app/keys' },
    { title: 'Add a profile', body: 'A profile is the brand or customer you publish on behalf of.', href: '/app/profiles' },
    { title: 'Connect an account', body: 'Link a social account so there is somewhere to publish.', href: '/app/connections' },
    { title: 'Publish', body: 'Compose once, send to every destination you selected.', href: '/app/compose' },
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
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-medium text-[var(--text-subtle)]">
                {index + 1}
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
