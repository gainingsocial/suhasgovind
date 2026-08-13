/**
 * Performance memory (plan Phase 10).
 *
 * Turns published posts and their analytics into statements a person or an agent can act
 * on: *video posts on LinkedIn average 2.3× the engagement rate of this profile's LinkedIn
 * average, over 31 posts*.
 *
 * The whole design is in the restraint. It would be trivial to emit a "learning" for every
 * bucket the moment a second post existed, and the result would be a product confidently
 * telling customers that Tuesdays are better because two Tuesday posts happened to do
 * well. Three rules stop that:
 *
 *   1. Nothing below `MIN_SAMPLE_SIZE` is emitted at all — not with a caveat, not greyed
 *      out. A finding nobody should act on should not be shown.
 *   2. Nothing is compared across providers. A video on TikTok and a video on LinkedIn
 *      share a word and nothing else, and averaging them produces a number describing
 *      neither.
 *   3. Rates and counts are never mixed. Engagement rate needs impressions, which several
 *      providers do not give for every post; where they are missing for any sample in a
 *      group, the whole group falls back to raw engagements and says so.
 *
 * Topic and hook performance are in the plan and are absent here. Both need an extraction
 * step, which needs a model provider, and inferring a topic from a keyword match would be
 * a guess presented as a measurement (Rule 14).
 */

/** Below this, a bucket is not reported. Five is not statistics — it is a floor. */
export const MIN_SAMPLE_SIZE = 5;

/** Lift closer to 1 than this is not worth a customer's attention. */
export const MIN_INTERESTING_LIFT = 0.15;

export type PerformanceDimension = 'format' | 'posting_hour' | 'posting_weekday';
export type PerformanceMetric = 'engagement_rate' | 'engagements';
export type Confidence = 'low' | 'medium' | 'high';

/** One published post, as the learner sees it. */
export interface PostSample {
  provider: string;
  /** Normalized post type — `video`, `image`, `carousel`, `text`. Null when unknown. */
  format: string | null;
  /** The provider's own publish time, already converted to the profile's timezone. */
  publishedAt: Date;
  engagements: number | null;
  impressions: number | null;
}

export interface PerformanceObservation {
  provider: string;
  dimension: PerformanceDimension;
  bucket: string;
  sampleSize: number;
  bucketMean: number;
  baselineMean: number;
  /** `bucketMean / baselineMean`. 1.0 is indistinguishable from this provider's average. */
  lift: number;
  metric: PerformanceMetric;
  confidence: Confidence;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Confidence from sample size alone.
 *
 * Deliberately not a p-value. Engagement is not normally distributed, one viral post
 * dominates any small sample, and a significance test on this data would lend a precision
 * the data does not have. Sample size is a claim we can actually defend, so it is the only
 * one made — and it is reported alongside the number rather than replacing it.
 */
export function confidenceFor(sampleSize: number): Confidence {
  if (sampleSize >= 30) return 'high';
  if (sampleSize >= 10) return 'medium';
  return 'low';
}

/**
 * Which metric a group of samples can honestly be compared on.
 *
 * Engagement rate is the better measure — it separates "this post was good" from "this
 * post was shown to more people" — but it needs impressions on *every* sample. Where one
 * is missing the group falls back to raw counts, because a mean computed over a mixture of
 * rates and counts describes nothing.
 */
function metricFor(samples: readonly PostSample[]): PerformanceMetric {
  const usable = samples.every(
    (sample) => sample.impressions !== null && sample.impressions > 0 && sample.engagements !== null,
  );
  return usable ? 'engagement_rate' : 'engagements';
}

function valueOf(sample: PostSample, metric: PerformanceMetric): number | null {
  if (sample.engagements === null) return null;
  if (metric === 'engagements') return sample.engagements;
  if (sample.impressions === null || sample.impressions <= 0) return null;
  return sample.engagements / sample.impressions;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function bucketOf(sample: PostSample, dimension: PerformanceDimension): string | null {
  switch (dimension) {
    case 'format':
      return sample.format;
    case 'posting_hour':
      return String(sample.publishedAt.getUTCHours());
    case 'posting_weekday':
      return WEEKDAYS[sample.publishedAt.getUTCDay()] ?? null;
  }
}

/**
 * Compute every observation worth storing.
 *
 * Grouped by provider first, then by dimension, then by bucket. The baseline is the
 * provider's own mean across all its samples — not a global mean and not an industry
 * figure. What a customer wants to know is whether *their* video posts beat *their* other
 * posts, and comparing them to somebody else's numbers answers a question nobody asked.
 */
export function computeObservations(
  samples: readonly PostSample[],
  dimensions: readonly PerformanceDimension[] = ['format', 'posting_hour', 'posting_weekday'],
): PerformanceObservation[] {
  const observations: PerformanceObservation[] = [];

  const byProvider = new Map<string, PostSample[]>();
  for (const sample of samples) {
    const list = byProvider.get(sample.provider) ?? [];
    list.push(sample);
    byProvider.set(sample.provider, list);
  }

  for (const [provider, providerSamples] of byProvider) {
    const metric = metricFor(providerSamples);

    const scored = providerSamples
      .map((sample) => ({ sample, value: valueOf(sample, metric) }))
      .filter((entry): entry is { sample: PostSample; value: number } => entry.value !== null);

    // A baseline computed from fewer posts than a bucket needs is not a baseline.
    if (scored.length < MIN_SAMPLE_SIZE) continue;

    const baselineMean = mean(scored.map((entry) => entry.value));
    // Every lift divides by this. A profile whose posts all scored zero has nothing to
    // learn from yet, and dividing by it would produce Infinity dressed as insight.
    if (baselineMean <= 0) continue;

    for (const dimension of dimensions) {
      const buckets = new Map<string, number[]>();

      for (const entry of scored) {
        const bucket = bucketOf(entry.sample, dimension);
        if (bucket === null) continue;
        const list = buckets.get(bucket) ?? [];
        list.push(entry.value);
        buckets.set(bucket, list);
      }

      for (const [bucket, values] of buckets) {
        if (values.length < MIN_SAMPLE_SIZE) continue;

        const bucketMean = mean(values);
        observations.push({
          provider,
          dimension,
          bucket,
          sampleSize: values.length,
          bucketMean,
          baselineMean,
          lift: bucketMean / baselineMean,
          metric,
          confidence: confidenceFor(values.length),
        });
      }
    }
  }

  return observations;
}

export interface Recommendation {
  /** Stable and machine-readable, so an agent branches on this rather than the sentence. */
  code: 'prefer_format' | 'avoid_format' | 'prefer_posting_hour' | 'prefer_posting_weekday';
  provider: string;
  dimension: PerformanceDimension;
  bucket: string;
  /** Plain language, and it always names the evidence. */
  statement: string;
  lift: number;
  sampleSize: number;
  confidence: Confidence;
}

function describeBucket(dimension: PerformanceDimension, bucket: string): string {
  switch (dimension) {
    case 'format':
      return `${bucket} posts`;
    case 'posting_hour':
      return `posts published in the ${bucket}:00 hour`;
    case 'posting_weekday':
      return `posts published on a ${bucket}`;
  }
}

/**
 * Turn observations into ranked, evidence-bearing advice.
 *
 * Every statement carries its own sample size and multiple, because a recommendation a
 * customer cannot audit is a recommendation they are right not to trust. Ranked by how
 * much difference it would make weighted by how much we know — a 3× lift over six posts
 * ranks below a 1.6× lift over eighty.
 */
export function recommendationsFrom(
  observations: readonly PerformanceObservation[],
): Recommendation[] {
  const weight: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

  const recommendations = observations
    .filter((observation) => Math.abs(observation.lift - 1) >= MIN_INTERESTING_LIFT)
    .map((observation) => {
      const better = observation.lift > 1;
      const multiple = observation.lift.toFixed(1);
      const measure =
        observation.metric === 'engagement_rate' ? 'engagement rate' : 'engagements';

      const code: Recommendation['code'] = !better
        ? 'avoid_format'
        : observation.dimension === 'format'
          ? 'prefer_format'
          : observation.dimension === 'posting_hour'
            ? 'prefer_posting_hour'
            : 'prefer_posting_weekday';

      return {
        code,
        provider: observation.provider,
        dimension: observation.dimension,
        bucket: observation.bucket,
        lift: observation.lift,
        sampleSize: observation.sampleSize,
        confidence: observation.confidence,
        statement:
          `On ${observation.provider}, ${describeBucket(observation.dimension, observation.bucket)} ` +
          `average ${multiple}× your ${measure} across all ${observation.provider} posts, ` +
          `over ${observation.sampleSize} posts.`,
      };
    });

  return recommendations.sort(
    (a, b) =>
      Math.abs(b.lift - 1) * weight[b.confidence] - Math.abs(a.lift - 1) * weight[a.confidence],
  );
}

/**
 * `avoid_format` is only meaningful for a format.
 *
 * An hour or a weekday that underperforms is not something to avoid — it is something to
 * post less at, which is the same advice as preferring the better hour and does not need
 * its own recommendation. Filtering here keeps the codes honest rather than emitting
 * "avoid Tuesday" from a code named after formats.
 */
export function usefulRecommendations(
  observations: readonly PerformanceObservation[],
): Recommendation[] {
  return recommendationsFrom(observations).filter(
    (recommendation) =>
      recommendation.code !== 'avoid_format' || recommendation.dimension === 'format',
  );
}
