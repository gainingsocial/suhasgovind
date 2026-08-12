/**
 * Analytics freshness tiers (plan Phase 6).
 *
 * Decides when a post's metrics are worth looking at again.
 *
 * The constraint that shapes everything: provider analytics calls come out of the same
 * rate-limit budget publishing depends on. A refresh policy that treats a three-year-old
 * post like a three-hour-old one will, on a customer with a few thousand posts, spend the
 * entire budget re-reading numbers that have not moved — and the first symptom is a failed
 * publish, not a stale chart.
 *
 * So the schedule follows the shape of engagement rather than the convenience of a cron.
 * Nearly all of a post's engagement arrives in its first day or two, and the curve is
 * effectively flat within a week.
 */

export type FreshnessTier = 'hot' | 'warm' | 'cool' | 'cold' | 'archived';

export interface FreshnessPlan {
  readonly tier: FreshnessTier;
  readonly intervalMs: number;
  readonly nextRefreshAt: Date;
  /** Why, in words, for a UI that has to explain "last checked 4 hours ago". */
  readonly rationale: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How old a post is, and therefore how fast its numbers are still moving.
 *
 * Ages are wall-clock from publication, not from the last observation. Deriving the tier
 * from "when did we last look" would make a post that went unobserved for a month look
 * urgent, when in fact it is the one whose numbers are most certainly settled.
 */
const TIERS: readonly { tier: FreshnessTier; maxAgeMs: number; intervalMs: number; rationale: string }[] =
  [
    {
      tier: 'hot',
      maxAgeMs: 6 * HOUR,
      intervalMs: 15 * MINUTE,
      rationale: 'Published in the last few hours, when engagement moves fastest.',
    },
    {
      tier: 'warm',
      maxAgeMs: 2 * DAY,
      intervalMs: 2 * HOUR,
      rationale: 'Published in the last two days; most engagement arrives in this window.',
    },
    {
      tier: 'cool',
      maxAgeMs: 7 * DAY,
      intervalMs: 12 * HOUR,
      rationale: 'Published this week; the curve is flattening.',
    },
    {
      tier: 'cold',
      maxAgeMs: 90 * DAY,
      intervalMs: 7 * DAY,
      rationale: 'Older than a week; checked weekly for late movement.',
    },
  ];

/**
 * Beyond the last tier.
 *
 * Refreshed rarely rather than never, because platforms revise historical figures and a
 * post can resurface. Never refreshing would leave a number that is quietly wrong forever,
 * which is worse than one that is knowably a month old.
 */
const ARCHIVED = {
  tier: 'archived' as const,
  intervalMs: 30 * DAY,
  rationale: 'Older than three months; refreshed monthly in case the provider revises it.',
};

export interface FreshnessInput {
  /** When the platform says it was published. */
  readonly publishedAt: Date | null;
  /** When we last successfully read its metrics. */
  readonly lastObservedAt: Date | null;
  readonly now?: Date;
}

/**
 * Plan the next refresh for one post.
 *
 * A post with no publication date is treated as `hot`. That is deliberately the cautious
 * direction: an unknown date usually means we just discovered it, and checking a settled
 * post too often costs one call, while checking a live one too rarely costs the customer
 * the only window in which the data was interesting.
 */
export function planFreshness(input: FreshnessInput): FreshnessPlan {
  const now = input.now ?? new Date();

  const tier = input.publishedAt
    ? (TIERS.find((entry) => now.getTime() - input.publishedAt!.getTime() < entry.maxAgeMs) ??
      ARCHIVED)
    : TIERS[0]!;

  /**
   * Scheduled from the last observation, not from now.
   *
   * Anchoring to `now` would let a refresh that ran late push the next one later still,
   * and the drift compounds: a two-hour tier observed at a two-hour-fifteen-minute delay
   * quietly becomes a two-and-a-quarter-hour tier, then a two-and-a-half.
   */
  const anchor = input.lastObservedAt ?? now;
  const scheduled = new Date(anchor.getTime() + tier.intervalMs);

  return {
    tier: tier.tier,
    intervalMs: tier.intervalMs,
    // Never in the past. A refresh that was missed is due immediately, not overdue by a
    // day — the sweep should catch up, not queue a backlog it treats as ancient.
    nextRefreshAt: scheduled.getTime() < now.getTime() ? now : scheduled,
    rationale: tier.rationale,
  };
}

/**
 * The normalized metric vocabulary (plan Phase 6).
 *
 * Every provider's numbers map onto these, and anything that does not map is preserved in
 * `native_metrics` rather than dropped — a normalized model that discards what it does not
 * recognize is a model that quietly loses the metric a customer's strategy depends on.
 */
export const NORMALIZED_METRICS = [
  'impressions',
  'reach',
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'clicks',
  'engagements',
  'watch_time_seconds',
  'followers_delta',
] as const;

export type NormalizedMetric = (typeof NORMALIZED_METRICS)[number];

export type MetricValues = Partial<Record<NormalizedMetric, number>>;

/**
 * Total interactions, when a provider does not report one directly.
 *
 * Derived only from what is actually present. Treating a missing metric as zero would make
 * a platform that does not report saves look less engaging than one that does, which is a
 * comparison a customer would reasonably draw and would be entirely an artefact of our
 * arithmetic.
 *
 * Returns null rather than 0 when nothing is known, so "no interactions" and "we have no
 * data" stay distinguishable.
 */
export function deriveEngagements(metrics: MetricValues): number | null {
  if (typeof metrics.engagements === 'number') return metrics.engagements;

  const components: NormalizedMetric[] = ['likes', 'comments', 'shares', 'saves', 'clicks'];
  const present = components.filter((key) => typeof metrics[key] === 'number');

  if (present.length === 0) return null;
  return present.reduce((total, key) => total + (metrics[key] ?? 0), 0);
}

/**
 * Engagement rate against reach, or impressions when reach is unavailable.
 *
 * Null when there is no denominator, never zero. A rate of 0% and "we cannot compute a
 * rate" look identical on a chart and mean opposite things — the first is a post that
 * nobody engaged with, the second is a platform that does not tell us how many people saw
 * it.
 */
export function engagementRate(metrics: MetricValues): number | null {
  const engagements = deriveEngagements(metrics);
  if (engagements === null) return null;

  const denominator = metrics.reach ?? metrics.impressions ?? null;
  if (denominator === null || denominator <= 0) return null;

  return engagements / denominator;
}

/**
 * The difference between two snapshots.
 *
 * Negative deltas are preserved rather than clamped. Providers really do revise numbers
 * downward — de-duplicating impressions, removing engagement from deleted accounts — and
 * clamping to zero would hide a correction that a customer comparing our figures to the
 * platform's own dashboard would immediately notice.
 */
export function metricDelta(previous: MetricValues, current: MetricValues): MetricValues {
  const delta: MetricValues = {};

  for (const metric of NORMALIZED_METRICS) {
    const before = previous[metric];
    const after = current[metric];

    // Only where both readings exist. A metric that appeared for the first time has no
    // meaningful delta, and reporting its full value as growth would be a fabrication.
    if (typeof before === 'number' && typeof after === 'number') {
      delta[metric] = after - before;
    }
  }

  return delta;
}
