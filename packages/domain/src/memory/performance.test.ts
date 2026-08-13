import { describe, expect, it } from 'vitest';

import {
  MIN_SAMPLE_SIZE,
  computeObservations,
  confidenceFor,
  recommendationsFrom,
  usefulRecommendations,
  type PostSample,
} from './performance.js';

/**
 * The tests that matter here are the ones about restraint. Anyone can verify that a mean
 * is a mean; the question this module has to answer correctly is *when to stay quiet*.
 */

const at = (iso: string): Date => new Date(iso);

function sample(overrides: Partial<PostSample> = {}): PostSample {
  return {
    provider: 'linkedin',
    format: 'text',
    publishedAt: at('2026-08-04T09:00:00Z'),
    engagements: 10,
    impressions: 1000,
    ...overrides,
  };
}

/** `count` samples in one bucket, all with the same engagement. */
function bucketSamples(count: number, overrides: Partial<PostSample>): PostSample[] {
  return Array.from({ length: count }, () => sample(overrides));
}

describe('computeObservations', () => {
  it('says nothing about a bucket below the minimum sample size', () => {
    const samples = [
      ...bucketSamples(MIN_SAMPLE_SIZE - 1, { format: 'video', engagements: 500 }),
      ...bucketSamples(20, { format: 'text', engagements: 10 }),
    ];

    const formats = computeObservations(samples, ['format']).map((o) => o.bucket);

    // The video posts are dramatically better and there are four of them. Four posts is
    // not a finding, and a spectacular number computed from four posts is the most
    // dangerous kind of noise.
    expect(formats).not.toContain('video');
    expect(formats).toContain('text');
  });

  it('says nothing at all when the profile has barely posted', () => {
    const samples = bucketSamples(MIN_SAMPLE_SIZE - 1, { format: 'video' });
    expect(computeObservations(samples)).toEqual([]);
  });

  it('never compares one network against another', () => {
    const samples = [
      ...bucketSamples(10, { provider: 'tiktok', format: 'video', engagements: 5000 }),
      ...bucketSamples(10, { provider: 'linkedin', format: 'video', engagements: 10 }),
    ];

    const observations = computeObservations(samples, ['format']);
    const linkedin = observations.find((o) => o.provider === 'linkedin' && o.bucket === 'video');

    // LinkedIn's video posts are its *only* posts, so they are exactly its average. If the
    // baseline had been pooled across providers, this would report a catastrophic lift.
    expect(linkedin?.lift).toBeCloseTo(1, 5);
  });

  it('falls back to raw engagements when impressions are missing for any sample', () => {
    const samples = [
      ...bucketSamples(6, { format: 'video', impressions: null, engagements: 40 }),
      ...bucketSamples(6, { format: 'text', impressions: 1000, engagements: 10 }),
    ];

    // Mixing a rate against a count would produce a mean describing neither.
    expect(computeObservations(samples, ['format']).every((o) => o.metric === 'engagements')).toBe(
      true,
    );
  });

  it('uses engagement rate when every sample has impressions', () => {
    const samples = [
      ...bucketSamples(6, { format: 'video', impressions: 100, engagements: 20 }),
      ...bucketSamples(6, { format: 'text', impressions: 1000, engagements: 20 }),
    ];

    const observations = computeObservations(samples, ['format']);
    expect(observations.every((o) => o.metric === 'engagement_rate')).toBe(true);

    // Same raw engagements, ten times the impressions — a count would call these equal.
    const video = observations.find((o) => o.bucket === 'video');
    const text = observations.find((o) => o.bucket === 'text');
    expect(video!.bucketMean).toBeGreaterThan(text!.bucketMean);
  });

  it('reports a real lift against the profile’s own baseline', () => {
    const samples = [
      ...bucketSamples(10, { format: 'video', impressions: 100, engagements: 30 }),
      ...bucketSamples(10, { format: 'text', impressions: 100, engagements: 10 }),
    ];

    const video = computeObservations(samples, ['format']).find((o) => o.bucket === 'video');

    // Baseline is the mean of 0.30 and 0.10, so 0.20. Video is 0.30, a lift of 1.5.
    expect(video!.lift).toBeCloseTo(1.5, 5);
    expect(video!.sampleSize).toBe(10);
  });

  it('stays quiet when every post scored zero rather than dividing by it', () => {
    const samples = bucketSamples(20, { engagements: 0, impressions: 100 });
    expect(computeObservations(samples)).toEqual([]);
  });

  it('skips samples whose bucket cannot be determined', () => {
    const samples = [
      ...bucketSamples(10, { format: null, engagements: 100 }),
      ...bucketSamples(10, { format: 'text', engagements: 10 }),
    ];

    const buckets = computeObservations(samples, ['format']).map((o) => o.bucket);
    expect(buckets).toEqual(['text']);
  });

  it('buckets by hour and weekday from the publish time', () => {
    const samples = bucketSamples(8, { publishedAt: at('2026-08-04T14:30:00Z') });

    const observations = computeObservations(samples, ['posting_hour', 'posting_weekday']);
    expect(observations.map((o) => o.bucket)).toEqual(['14', 'tuesday']);
  });
});

describe('confidenceFor', () => {
  it('scales with sample size and nothing else', () => {
    expect(confidenceFor(5)).toBe('low');
    expect(confidenceFor(9)).toBe('low');
    expect(confidenceFor(10)).toBe('medium');
    expect(confidenceFor(29)).toBe('medium');
    expect(confidenceFor(30)).toBe('high');
  });
});

describe('recommendationsFrom', () => {
  const observations = computeObservations(
    [
      ...bucketSamples(40, { format: 'video', impressions: 100, engagements: 16 }),
      ...bucketSamples(40, { format: 'text', impressions: 100, engagements: 10 }),
    ],
    ['format'],
  );

  it('names the evidence in the statement itself', () => {
    const video = recommendationsFrom(observations).find((r) => r.bucket === 'video');

    expect(video?.statement).toContain('over 40 posts');
    expect(video?.statement).toContain('linkedin');
    expect(video?.code).toBe('prefer_format');
  });

  it('drops a difference too small to act on', () => {
    const flat = computeObservations(
      [
        ...bucketSamples(20, { format: 'video', impressions: 100, engagements: 21 }),
        ...bucketSamples(20, { format: 'text', impressions: 100, engagements: 20 }),
      ],
      ['format'],
    );

    // A 2.5% difference is not advice, it is a rounding error with a sentence attached.
    expect(recommendationsFrom(flat)).toEqual([]);
  });

  it('ranks a smaller, better-evidenced effect above a larger, thinner one', () => {
    const mixed = [
      ...computeObservations(
        [
          ...bucketSamples(40, { provider: 'linkedin', format: 'video', impressions: 100, engagements: 16 }),
          ...bucketSamples(40, { provider: 'linkedin', format: 'text', impressions: 100, engagements: 10 }),
        ],
        ['format'],
      ),
      ...computeObservations(
        [
          ...bucketSamples(6, { provider: 'tiktok', format: 'video', impressions: 100, engagements: 40 }),
          ...bucketSamples(6, { provider: 'tiktok', format: 'image', impressions: 100, engagements: 10 }),
        ],
        ['format'],
      ),
    ];

    const ranked = recommendationsFrom(mixed);
    expect(ranked[0]?.provider).toBe('linkedin');
    expect(ranked[0]?.confidence).toBe('high');
  });

  it('never tells anyone to avoid a weekday', () => {
    const byDay = computeObservations(
      [
        ...bucketSamples(10, {
          publishedAt: at('2026-08-04T09:00:00Z'),
          impressions: 100,
          engagements: 5,
        }),
        ...bucketSamples(10, {
          publishedAt: at('2026-08-06T09:00:00Z'),
          impressions: 100,
          engagements: 30,
        }),
      ],
      ['posting_weekday'],
    );

    const codes = usefulRecommendations(byDay).map((r) => r.code);
    expect(codes).not.toContain('avoid_format');
    expect(codes).toContain('prefer_posting_weekday');
  });
});
