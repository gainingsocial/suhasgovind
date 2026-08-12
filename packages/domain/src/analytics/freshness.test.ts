import { describe, expect, it } from 'vitest';

import {
  NORMALIZED_METRICS,
  deriveEngagements,
  engagementRate,
  metricDelta,
  planFreshness,
} from './freshness.js';

/**
 * Analytics freshness and metric normalization (plan Phase 6).
 *
 * Two properties matter here and both are about honesty rather than arithmetic: a missing
 * number must never be reported as zero, and a refresh schedule must not quietly drift.
 * The first misleads a customer about their own performance; the second spends a rate-limit
 * budget that publishing also needs.
 */

const now = new Date('2026-08-13T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('freshness tiers', () => {
  it('checks a post published minutes ago frequently', () => {
    const plan = planFreshness({ publishedAt: ago(30 * MINUTE), lastObservedAt: now, now });

    expect(plan.tier).toBe('hot');
    expect(plan.intervalMs).toBe(15 * MINUTE);
  });

  it('slows down once the first day has passed', () => {
    expect(planFreshness({ publishedAt: ago(DAY), lastObservedAt: now, now }).tier).toBe('warm');
  });

  it('slows down again after a couple of days', () => {
    expect(planFreshness({ publishedAt: ago(4 * DAY), lastObservedAt: now, now }).tier).toBe('cool');
  });

  it('checks a post older than a week only weekly', () => {
    const plan = planFreshness({ publishedAt: ago(30 * DAY), lastObservedAt: now, now });

    expect(plan.tier).toBe('cold');
    expect(plan.intervalMs).toBe(7 * DAY);
  });

  it('still checks a very old post occasionally rather than never', () => {
    // Platforms revise historical figures, and a post can resurface. Never refreshing
    // leaves a number quietly wrong forever, which is worse than one knowably a month old.
    const plan = planFreshness({ publishedAt: ago(400 * DAY), lastObservedAt: now, now });

    expect(plan.tier).toBe('archived');
    expect(plan.intervalMs).toBe(30 * DAY);
  });

  it('treats an unknown publication date as hot', () => {
    // Usually means we just discovered it. Checking a settled post too often costs one
    // call; checking a live one too rarely costs the customer the window that mattered.
    expect(planFreshness({ publishedAt: null, lastObservedAt: null, now }).tier).toBe('hot');
  });

  it('explains itself in words a UI can show', () => {
    expect(planFreshness({ publishedAt: ago(HOUR), lastObservedAt: now, now }).rationale).toContain(
      'engagement',
    );
  });
});

describe('scheduling', () => {
  it('anchors to the last observation, so a late run does not push the next one later', () => {
    // Anchoring to `now` lets drift compound: a two-hour tier observed fifteen minutes late
    // quietly becomes a two-and-a-quarter-hour tier, then a two-and-a-half.
    const lastObservedAt = ago(30 * MINUTE);
    const plan = planFreshness({ publishedAt: ago(DAY), lastObservedAt, now });

    expect(plan.nextRefreshAt.getTime()).toBe(lastObservedAt.getTime() + 2 * HOUR);
  });

  it('is due immediately when a refresh was missed, not overdue by a day', () => {
    // The sweep should catch up, not inherit a backlog it treats as ancient.
    const plan = planFreshness({ publishedAt: ago(DAY), lastObservedAt: ago(10 * DAY), now });

    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime());
  });

  it('schedules from now for a post never observed', () => {
    const plan = planFreshness({ publishedAt: ago(HOUR), lastObservedAt: null, now });

    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime() + 15 * MINUTE);
  });
});

describe('deriveEngagements', () => {
  it('uses the provider’s own figure when it reports one', () => {
    expect(deriveEngagements({ engagements: 412, likes: 1 })).toBe(412);
  });

  it('sums the components when it does not', () => {
    expect(deriveEngagements({ likes: 10, comments: 3, shares: 2 })).toBe(15);
  });

  it('sums only what is present, never treating absence as zero', () => {
    // A platform that does not report saves must not look less engaging than one that
    // does — that is a comparison a customer would reasonably draw, and it would be
    // entirely an artefact of our arithmetic.
    expect(deriveEngagements({ likes: 10 })).toBe(10);
  });

  it('returns null rather than zero when nothing is known', () => {
    // "No interactions" and "we have no data" must stay distinguishable.
    expect(deriveEngagements({})).toBeNull();
    expect(deriveEngagements({ impressions: 5_000 })).toBeNull();
  });

  it('reports a genuine zero as zero', () => {
    expect(deriveEngagements({ likes: 0, comments: 0 })).toBe(0);
  });
});

describe('engagementRate', () => {
  it('divides by reach when reach is available', () => {
    expect(engagementRate({ likes: 50, reach: 1_000 })).toBeCloseTo(0.05, 5);
  });

  it('falls back to impressions when reach is not', () => {
    expect(engagementRate({ likes: 50, impressions: 500 })).toBeCloseTo(0.1, 5);
  });

  it('prefers reach over impressions when both are present', () => {
    // Reach is people; impressions are views. Rate against people is the one a human means.
    expect(engagementRate({ likes: 50, reach: 1_000, impressions: 5_000 })).toBeCloseTo(0.05, 5);
  });

  it('returns null with no denominator rather than zero', () => {
    // 0% and "we cannot compute a rate" look identical on a chart and mean opposite things.
    expect(engagementRate({ likes: 50 })).toBeNull();
    expect(engagementRate({ likes: 50, reach: 0 })).toBeNull();
  });

  it('returns null when there is nothing to divide', () => {
    expect(engagementRate({ reach: 1_000 })).toBeNull();
  });
});

describe('metricDelta', () => {
  it('reports growth between two readings', () => {
    expect(metricDelta({ likes: 10, views: 100 }, { likes: 25, views: 400 })).toEqual({
      likes: 15,
      views: 300,
    });
  });

  it('preserves a downward revision rather than clamping it', () => {
    // Providers really do revise figures down — de-duplicating impressions, removing
    // engagement from deleted accounts. Clamping would hide a correction a customer
    // comparing our numbers to the platform's own dashboard would immediately notice.
    expect(metricDelta({ impressions: 1_000 }, { impressions: 900 })).toEqual({
      impressions: -100,
    });
  });

  it('omits a metric that appeared for the first time', () => {
    // Reporting its full value as growth would be a fabrication: it may have been that
    // high all along and simply unreported.
    expect(metricDelta({ likes: 5 }, { likes: 8, saves: 40 })).toEqual({ likes: 3 });
  });

  it('omits a metric that disappeared', () => {
    expect(metricDelta({ likes: 5, saves: 2 }, { likes: 8 })).toEqual({ likes: 3 });
  });

  it('returns nothing when the readings share no metric', () => {
    expect(metricDelta({ likes: 5 }, { views: 100 })).toEqual({});
  });

  it('covers every normalized metric', () => {
    const before = Object.fromEntries(NORMALIZED_METRICS.map((metric) => [metric, 1]));
    const after = Object.fromEntries(NORMALIZED_METRICS.map((metric) => [metric, 3]));

    expect(Object.keys(metricDelta(before, after))).toHaveLength(NORMALIZED_METRICS.length);
  });
});
