import type { Post, PostTarget, PostTargetAttempt } from '@gs/db';
import { describe, expect, it } from 'vitest';

import { buildPostTimeline } from './timeline.js';

/**
 * Timeline assembly (plan §40).
 *
 * The property under test is ordering. A timeline that groups by target reads as though
 * each destination happened in isolation, and hides the thing developers open it for:
 * that one provider stalled while another finished in seconds.
 */

const BASE = new Date('2026-08-12T10:00:00.000Z');
const at = (seconds: number): Date => new Date(BASE.getTime() + seconds * 1000);

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: '019ff000-0000-7000-8000-000000000001',
    status: 'published',
    createdAt: BASE,
    updatedAt: at(24),
    publishAt: null,
    ...overrides,
  } as Post;
}

function target(id: string, provider: string, createdAt: Date): PostTarget {
  return { id, provider, createdAt } as PostTarget;
}

function attempt(overrides: Partial<PostTargetAttempt>): PostTargetAttempt {
  return {
    id: 'a',
    postTargetId: 't1',
    attemptNumber: 1,
    startedAt: BASE,
    finishedAt: null,
    outcome: null,
    providerPostId: null,
    errorCode: null,
    errorMessage: null,
    durationMs: null,
    ...overrides,
  } as PostTargetAttempt;
}

describe('buildPostTimeline', () => {
  const targets = [
    target('019ff000-0000-7000-8000-0000000000a1', 'instagram', at(2)),
    target('019ff000-0000-7000-8000-0000000000a2', 'linkedin', at(2)),
  ];

  it('interleaves targets in time order rather than grouping them', () => {
    const events = buildPostTimeline(post(), targets, [
      attempt({
        postTargetId: targets[0]!.id,
        startedAt: at(3),
        finishedAt: at(11),
        outcome: 'provider_processing',
      }),
      attempt({
        postTargetId: targets[1]!.id,
        startedAt: at(4),
        finishedAt: at(7),
        outcome: 'published',
        providerPostId: 'urn:li:share:123',
      }),
    ]);

    const order = events.map((event) => `${event.at.slice(17, 19)} ${event.type}`);

    // LinkedIn publishing at :04 must appear before Instagram finishing at :11, even
    // though Instagram's attempt started first.
    expect(order).toEqual([
      '00 post.accepted',
      '02 target.queued',
      '02 target.queued',
      '03 target.publishing',
      '04 target.publishing',
      '07 target.published',
      '11 target.provider_processing',
      '24 post.published',
    ]);
  });

  it('names the provider post id when one exists', () => {
    const events = buildPostTimeline(post(), targets, [
      attempt({
        postTargetId: targets[1]!.id,
        startedAt: at(4),
        finishedAt: at(7),
        outcome: 'published',
        providerPostId: 'urn:li:share:123',
      }),
    ]);

    const published = events.find((event) => event.type === 'target.published');
    expect(published?.message).toContain('urn:li:share:123');
    expect(published?.provider).toBe('linkedin');
  });

  it('reports an ambiguous outcome as reconciliation, never as a failure', () => {
    const events = buildPostTimeline(post({ status: 'partially_published' }), targets, [
      attempt({
        postTargetId: targets[0]!.id,
        startedAt: at(3),
        finishedAt: at(33),
        outcome: 'unknown_reconciliation_required',
      }),
    ]);

    const entry = events.find((event) => event.type === 'target.reconciliation_required');
    expect(entry).toBeDefined();
    // Calling this a failure would be a lie in the most expensive direction: the post may
    // well have published, and a developer told "failed" will retry it by hand.
    expect(events.some((event) => event.type === 'target.failed')).toBe(false);
    expect(entry?.message).toContain('unknown');
  });

  it('omits an aggregate entry while the post is still queued', () => {
    const events = buildPostTimeline(post({ status: 'queued' }), targets, []);
    expect(events.some((event) => event.type.startsWith('post.') && event.type !== 'post.accepted')).toBe(
      false,
    );
  });

  it('records an in-flight attempt without inventing an outcome', () => {
    const events = buildPostTimeline(post({ status: 'publishing' }), targets, [
      attempt({ postTargetId: targets[0]!.id, startedAt: at(3), finishedAt: null, outcome: null }),
    ]);

    expect(events.filter((event) => event.type === 'target.publishing')).toHaveLength(1);
    expect(events.some((event) => event.type.startsWith('target.attempt_finished'))).toBe(false);
  });
});
