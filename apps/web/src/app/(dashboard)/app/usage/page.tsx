import { renderLoadFailure } from '@/components/page-states';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';

export const metadata = { title: 'Usage' };

/**
 * Usage (plan §70).
 *
 * Metering has been recording since long before anything is charged for, which is the right
 * order — a billing system switched on at the same time as billing has no history to check
 * itself against. This page is the customer-facing half of that: what you have used, plainly,
 * with no invoice attached yet.
 *
 * Scoped to the selected environment rather than the organization. Usage is organization-level
 * data and an environment is a slice of it, but showing the organization total on a screen
 * labelled with one environment would invite somebody to reconcile two numbers that were never
 * the same measurement.
 */

interface UsageTotal {
  metric: string;
  quantity: number;
}

interface UsageResponse {
  object: 'usage';
  from: string;
  to: string;
  totals: UsageTotal[];
  daily: { date: string; quantity: number }[];
}

const EMPTY: UsageResponse = {
  object: 'usage',
  from: '',
  to: '',
  totals: [],
  daily: [],
};

/**
 * Metric names as a person would say them.
 *
 * These are stable machine identifiers in the API, where that is correct — a billing
 * integration must not break because we improved a label. Rule C2 applies here: the studio
 * says what the thing is, the API says what it is called.
 */
const METRIC_LABEL: Record<string, { label: string; help: string }> = {
  successful_publish: {
    label: 'Posts published',
    help: 'One per network a post actually reached — a post to four networks counts four times.',
  },
  post_target_attempt: {
    label: 'Publish attempts',
    help: 'Every try, including retries. Higher than posts published when a network was having a bad day.',
  },
  api_request: { label: 'API calls', help: 'Every request to the API, including the ones this studio makes.' },
  connected_account_day: {
    label: 'Connected accounts',
    help: 'Counted once per account per day. Shown for transparency — connecting accounts is never what you pay for.',
  },
  media_processed_minute: {
    label: 'Media processed',
    help: 'Minutes of video and image work, including auto-fit crops and re-encodes.',
  },
  media_storage_byte_day: {
    label: 'Media stored',
    help: 'What your uploaded files occupy, counted per day they are held.',
  },
  analytics_sync: { label: 'Analytics refreshes', help: 'Times we went and collected fresh numbers.' },
  webhook_delivery: { label: 'Webhooks sent', help: 'Signed callbacks delivered to your endpoints.' },
  source_fetch: { label: 'Feed checks', help: 'Times we looked at one of your sources for new items.' },
  source_item_processed: { label: 'Articles ingested', help: 'New items pulled in from your sources.' },
  llm_input_tokens: { label: 'AI text read', help: 'What the model was given. Publishing never needs this.' },
  llm_output_tokens: { label: 'AI text written', help: 'What the model produced for drafts and extraction.' },
  repurpose_job: { label: 'Repurpose jobs', help: 'Times one source was turned into a set of posts.' },
};

function present(metric: string): { label: string; help: string } {
  return METRIC_LABEL[metric] ?? { label: metric.replace(/_/g, ' '), help: '' };
}

function formatQuantity(metric: string, quantity: number): string {
  /**
   * Byte-days are the awkward one.
   *
   * The unit is "a byte held for a day", which is correct for billing and meaningless to
   * read. Dividing by the period would imply a precision the summary does not carry, so it
   * is shown as-is with the unit named — an honest large number beats a tidy wrong one.
   */
  if (metric === 'media_storage_byte_day') {
    if (quantity >= 1_000_000_000) return `${(quantity / 1_000_000_000).toFixed(2)} GB·days`;
    if (quantity >= 1_000_000) return `${(quantity / 1_000_000).toFixed(1)} MB·days`;
    if (quantity >= 1_000) return `${(quantity / 1_000).toFixed(1)} kB·days`;
    return `${quantity} B·days`;
  }

  return quantity.toLocaleString();
}

export default async function UsagePage() {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const usage = await sessionFetchOr<UsageResponse>(context, '/v1/usage', EMPTY);

  const measured = usage.totals.filter((total) => total.quantity > 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Usage</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          What this environment has used over the last 30 days.
        </p>
      </header>

      <Card>
        <CardHeader
          title="This period"
          description={
            usage.from && usage.to
              ? `${usage.from} to ${usage.to}, in UTC days`
              : 'The last 30 days'
          }
        />

        {measured.length === 0 ? (
          <EmptyState
            title="Nothing used yet"
            description="Publish something and the counts start here. Nothing is charged for today — this is recorded so there is a history to check against when it is."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {measured.map((total) => {
              const { label, help } = present(total.metric);

              return (
                <li key={total.metric} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3.5 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{label}</p>
                    {help ? (
                      <p className="mt-0.5 text-xs text-[var(--text-subtle)]">{help}</p>
                    ) : null}
                  </div>
                  <p className="text-lg font-semibold tabular-nums">
                    {formatQuantity(total.metric, total.quantity)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/*
        Said plainly rather than left to be inferred. Somebody looking at a usage page
        naturally wonders what it will cost, and the honest answer today is "nothing".
      */}
      <p className="text-xs text-[var(--text-subtle)]">
        Nothing here is billed yet. When it is, the price will be on what you publish and the
        AI work you ask for — never per connected account and never per person on your team.
      </p>
    </div>
  );
}
