import { BrandSwitcher } from '@/components/brand-switcher';
import { renderLoadFailure } from '@/components/page-states';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import type { ListResponse } from '@/lib/api';
import { resolveBrand } from '@/lib/brands';
import { dashboardContext, sessionFetchOr } from '@/lib/session-api';
import { LearnButton } from './learn-button';

export const metadata = { title: 'Insights' };

/**
 * Insights (creator plan §5.5).
 *
 * Findings first, numbers second — the inversion of what every competitor ships.
 *
 * "Your Tuesday 9am posts get 2.3× the reach of your Friday posts" is a sentence somebody
 * can act on before lunch. A line chart of impressions is a puzzle they have to solve first,
 * and most people never do. The engine already computes the sentence: `/v1/recommendations`
 * returns `statement` fields written in plain language, grounded in stored analytics, and
 * suppressed entirely below a minimum sample size. This page leads with them.
 *
 * Totals still appear, underneath, because a creator does want to know whether the month
 * was up. They are a second question, so they get second position.
 */

interface Recommendation {
  object: 'recommendation';
  code: string;
  provider: string;
  dimension: string;
  bucket: string;
  statement: string;
  lift: number;
  sample_size: number;
  confidence: 'low' | 'medium' | 'high';
}

interface RecommendationList extends ListResponse<Recommendation> {
  /** Distinguishes "nothing learned yet" from "everything learned was unremarkable". */
  reason: 'ok' | 'not_enough_data' | 'nothing_notable';
}

interface AnalyticsSummary {
  object: 'analytics_summary';
  posts: number;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
  engagement_rate: number | null;
}

interface Observation {
  object: 'performance_observation';
  provider: string;
  dimension: 'format' | 'posting_hour' | 'posting_weekday';
  bucket: string;
  sample_size: number;
  bucket_mean: number;
  baseline_mean: number;
  lift: number;
  metric: 'engagement_rate' | 'engagements';
  confidence: 'low' | 'medium' | 'high';
  computed_at: string;
}

const EMPTY_RECOMMENDATIONS: RecommendationList = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
  reason: 'not_enough_data',
};

const EMPTY_SUMMARY: AnalyticsSummary = {
  object: 'analytics_summary',
  posts: 0,
  impressions: null,
  reach: null,
  engagements: null,
  engagement_rate: null,
};

const EMPTY_OBSERVATIONS: ListResponse<Observation> = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
};

/** Dimension names as a person would say them. Rule C2 applies to data, not just screens. */
const DIMENSION_LABEL: Record<string, string> = {
  format: 'Post format',
  posting_hour: 'Time of day',
  posting_weekday: 'Day of week',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Render a bucket key as a label.
 *
 * The engine stores `posting_hour` as a UTC hour number and `posting_weekday` as an index,
 * because those are what it can compute against. Neither is something to show a person.
 */
function bucketLabel(dimension: string, bucket: string): string {
  if (dimension === 'posting_weekday') {
    const index = Number(bucket);
    return Number.isInteger(index) && WEEKDAYS[index] ? WEEKDAYS[index]! : bucket;
  }

  if (dimension === 'posting_hour') {
    const hour = Number(bucket);
    if (!Number.isInteger(hour)) return bucket;
    const suffix = hour < 12 ? 'am' : 'pm';
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return `${twelve}${suffix} UTC`;
  }

  return bucket.replace(/_/g, ' ');
}

/** A multiplier reads faster than a percentage when the point is "more than usual". */
function liftLabel(lift: number): string {
  if (lift >= 0) return `${(1 + lift).toFixed(1)}× the usual`;
  return `${Math.round(Math.abs(lift) * 100)}% below usual`;
}

function formatCount(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  let context;
  try {
    context = await dashboardContext();
  } catch (error) {
    return <div className="space-y-6">{renderLoadFailure(error)}</div>;
  }

  const { brand } = await searchParams;
  const { brands, selected } = await resolveBrand(context, brand);

  const header = (
    <header className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Insights</h1>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          What your posting actually taught us, in words before numbers.
        </p>
      </div>
      <BrandSwitcher brands={brands} selected={selected} basePath="/app/insights" />
    </header>
  );

  /**
   * No brand yet is a setup state, not an empty chart.
   *
   * Every read below is per profile, so without one there is nothing to ask for — and
   * rendering zeroes would tell a new user their content performs badly when in truth
   * nothing has been measured.
   */
  if (!selected) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState
            title="No brand yet"
            description="Insights are per brand — create one, connect an account and publish a few posts, and findings show up here."
          />
        </Card>
      </div>
    );
  }

  const scope = `profile_id=${selected.id}`;

  // Fetched together and degraded independently: one failing endpoint must not replace the
  // page with an error screen when the other two still carry what somebody came for.
  const [recommendations, summary, observations] = await Promise.all([
    sessionFetchOr<RecommendationList>(context, `/v1/recommendations?${scope}`, EMPTY_RECOMMENDATIONS),
    sessionFetchOr<AnalyticsSummary>(context, `/v1/analytics/summary?${scope}`, EMPTY_SUMMARY),
    sessionFetchOr<ListResponse<Observation>>(context, `/v1/memory/performance?${scope}`, EMPTY_OBSERVATIONS),
  ]);

  const lastComputed = observations.data[0]?.computed_at ?? null;

  return (
    <div className="space-y-6">
      {header}

      {/* The findings. The reason for the page. */}
      <Card>
        <CardHeader
          title="What we have learned"
          description="Computed from your own results — never guessed, and never shown below a sample size that would make it noise"
          action={<LearnButton profileId={selected.id} />}
        />

        {recommendations.data.length === 0 ? (
          /*
           * Two empty states, deliberately. "Nothing has been learned yet" and "everything
           * learned was unremarkable" look identical in an empty array, and telling a
           * brand-new customer their content is average when nobody has measured it is the
           * worse of the two mistakes. The API distinguishes them; so does this.
           */
          recommendations.reason === 'not_enough_data' ? (
            <EmptyState
              title="Not enough published yet"
              description="Findings need a handful of published posts with analytics collected. Keep publishing — this fills in on its own."
            />
          ) : (
            <EmptyState
              title="Nothing stands out yet"
              description="We read your posts and found no pattern strong enough to be worth acting on. That is a real answer, not a missing one — your results are fairly even across formats and times."
            />
          )
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {recommendations.data.map((item) => (
              <li key={`${item.code}-${item.provider}-${item.bucket}`} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/* The sentence is the content. Everything else is provenance. */}
                  <p className="min-w-0 flex-1 text-sm font-medium">{item.statement}</p>
                  <Badge tone={item.lift >= 0 ? 'ok' : 'warn'}>{liftLabel(item.lift)}</Badge>
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-subtle)]">
                  {item.provider} · {DIMENSION_LABEL[item.dimension] ?? item.dimension} ·{' '}
                  {bucketLabel(item.dimension, item.bucket)} · from {item.sample_size} posts ·{' '}
                  {item.confidence} confidence
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Totals. The second question, in second position. */}
      <Card>
        <CardHeader
          title="The numbers"
          description="Across every network this brand publishes to"
        />
        <dl className="grid grid-cols-2 gap-px bg-[var(--border)] sm:grid-cols-5">
          {[
            { label: 'Posts', value: summary.posts.toLocaleString() },
            { label: 'Impressions', value: formatCount(summary.impressions) },
            { label: 'Reach', value: formatCount(summary.reach) },
            { label: 'Engagements', value: formatCount(summary.engagements) },
            {
              label: 'Engagement rate',
              value:
                summary.engagement_rate === null
                  ? '—'
                  : `${(summary.engagement_rate * 100).toFixed(1)}%`,
            },
          ].map((stat) => (
            <div key={stat.label} className="bg-[var(--surface-raised)] px-4 py-3">
              <dt className="text-xs text-[var(--text-subtle)]">{stat.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
        {/*
          An em dash means "no platform has reported this metric", which is different from
          zero. Saying so stops somebody reading a gap in provider coverage as a collapse in
          their reach.
        */}
        <p className="border-t px-4 py-2.5 text-xs text-[var(--text-subtle)]">
          A dash means no network has reported that metric yet — it is not a zero.
        </p>
      </Card>

      {/* The working. Present so a finding can be checked rather than believed. */}
      <Card>
        <CardHeader
          title="Everything measured"
          description={
            lastComputed
              ? `Every pattern found, including the ones too weak to recommend. Last read ${new Date(lastComputed).toLocaleDateString()}`
              : 'Every pattern found, including the ones too weak to recommend'
          }
        />
        {observations.data.length === 0 ? (
          <EmptyState
            title="Nothing measured yet"
            description="Publish a few posts and press Refresh findings, and the working shows up here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-[var(--text-subtle)]">
                  <th scope="col" className="px-4 py-2 font-medium">What</th>
                  <th scope="col" className="px-4 py-2 font-medium">Which</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Posts</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">vs usual</th>
                  <th scope="col" className="px-4 py-2 font-medium">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {observations.data.map((row) => (
                  <tr key={`${row.provider}-${row.dimension}-${row.bucket}`}>
                    <td className="px-4 py-2.5">
                      {DIMENSION_LABEL[row.dimension] ?? row.dimension}
                      <span className="ml-1.5 text-xs text-[var(--text-subtle)]">
                        {row.provider}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{bucketLabel(row.dimension, row.bucket)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{row.sample_size}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {row.lift >= 0 ? '+' : ''}
                      {Math.round(row.lift * 100)}%
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={row.confidence === 'high' ? 'ok' : 'neutral'}>
                        {row.confidence}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
