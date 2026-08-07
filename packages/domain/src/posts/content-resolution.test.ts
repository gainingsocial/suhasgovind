import { describe, expect, it } from 'vitest';

import {
  buildFingerprintInput,
  canonicalizeForHashing,
  resolveTargetContent,
} from './content-resolution.js';

describe('resolveTargetContent', () => {
  const canonical = { text: 'We are launching today.', media_ids: ['med_1', 'med_2'] };

  it('uses canonical content when nothing is overridden', () => {
    const resolved = resolveTargetContent({ canonical, provider: 'linkedin' });

    expect(resolved.text).toBe('We are launching today.');
    expect(resolved.media_ids).toEqual(['med_1', 'med_2']);
  });

  it('lets a target override the text', () => {
    const resolved = resolveTargetContent({
      canonical,
      overrides: { text: "We're live 🚀" },
      provider: 'instagram',
    });

    expect(resolved.text).toBe("We're live 🚀");
    expect(resolved.media_ids).toEqual(['med_1', 'med_2']);
  });

  it('honours an explicit empty media override', () => {
    // The distinction that a deep merge would destroy: `[]` means "no media here",
    // not "fall back to the canonical media".
    const resolved = resolveTargetContent({ canonical, overrides: { media_ids: [] }, provider: 'bluesky' });

    expect(resolved.media_ids).toEqual([]);
  });

  it('honours an explicit empty text override', () => {
    const resolved = resolveTargetContent({ canonical, overrides: { text: '' }, provider: 'bluesky' });

    expect(resolved.text).toBe('');
  });

  it('narrows provider options to the target provider only', () => {
    const resolved = resolveTargetContent({
      canonical,
      options: { instagram: { type: 'reel' }, linkedin: { visibility: 'PUBLIC' } },
      provider: 'instagram',
    });

    expect(resolved.options).toEqual({ type: 'reel' });
  });

  it('yields empty options when the provider has none', () => {
    const resolved = resolveTargetContent({
      canonical,
      options: { instagram: { type: 'reel' } },
      provider: 'linkedin',
    });

    expect(resolved.options).toEqual({});
  });

  it('does not alias the canonical media array', () => {
    // A mutation while preparing one target must not corrupt the next.
    const resolved = resolveTargetContent({ canonical, provider: 'bluesky' });
    resolved.media_ids.push('med_3');

    expect(canonical.media_ids).toEqual(['med_1', 'med_2']);
  });

  it('carries non-reserved canonical and override fields through as extras', () => {
    const resolved = resolveTargetContent({
      canonical: { ...canonical, alt_texts: ['a', 'b'] },
      overrides: { location_id: 'loc_1' },
      provider: 'instagram',
    });

    expect(resolved.extra).toEqual({ alt_texts: ['a', 'b'], location_id: 'loc_1' });
  });

  it('treats a null override the same as none', () => {
    expect(resolveTargetContent({ canonical, overrides: null, provider: 'x' }).text).toBe(
      'We are launching today.',
    );
  });
});

describe('canonicalizeForHashing', () => {
  it('is insensitive to object key order', () => {
    // A client library that reorders keys between retries must not be told its
    // Idempotency-Key was reused with a different body.
    const a = canonicalizeForHashing({ text: 'hi', targets: [{ destination_id: 'dst_1' }] });
    const b = canonicalizeForHashing({ targets: [{ destination_id: 'dst_1' }], text: 'hi' });

    expect(a).toBe(b);
  });

  it('is sensitive to array order', () => {
    // Target order and carousel media order are both meaningful.
    const a = canonicalizeForHashing({ media_ids: ['med_1', 'med_2'] });
    const b = canonicalizeForHashing({ media_ids: ['med_2', 'med_1'] });

    expect(a).not.toBe(b);
  });

  it('sorts nested objects too', () => {
    const a = canonicalizeForHashing({ options: { instagram: { type: 'reel', share: true } } });
    const b = canonicalizeForHashing({ options: { instagram: { share: true, type: 'reel' } } });

    expect(a).toBe(b);
  });

  it('treats an explicitly undefined field as absent, matching JSON', () => {
    expect(canonicalizeForHashing({ a: 1, b: undefined })).toBe(canonicalizeForHashing({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(canonicalizeForHashing({ a: null })).not.toBe(canonicalizeForHashing({}));
  });

  it('distinguishes genuinely different bodies', () => {
    expect(canonicalizeForHashing({ text: 'a' })).not.toBe(canonicalizeForHashing({ text: 'b' }));
  });
});

describe('buildFingerprintInput', () => {
  const at = new Date('2026-08-07T05:16:00.000Z');

  it('matches for identical content in the same time bucket', () => {
    const one = buildFingerprintInput({ provider: 'bluesky', destinationId: 'dst_1', text: 'Hello', publishAt: at });
    const two = buildFingerprintInput({
      provider: 'bluesky',
      destinationId: 'dst_1',
      text: 'Hello',
      publishAt: new Date('2026-08-07T05:59:00.000Z'),
    });

    expect(one).toBe(two);
  });

  it('differs across time buckets, so a genuine repost is not blocked', () => {
    const one = buildFingerprintInput({ provider: 'bluesky', destinationId: 'dst_1', text: 'Hello', publishAt: at });
    const later = buildFingerprintInput({
      provider: 'bluesky',
      destinationId: 'dst_1',
      text: 'Hello',
      publishAt: new Date('2026-08-14T05:16:00.000Z'),
    });

    expect(one).not.toBe(later);
  });

  it('differs per destination, so a fan-out is never seen as a duplicate', () => {
    const a = buildFingerprintInput({ provider: 'bluesky', destinationId: 'dst_1', text: 'Hi', publishAt: at });
    const b = buildFingerprintInput({ provider: 'bluesky', destinationId: 'dst_2', text: 'Hi', publishAt: at });

    expect(a).not.toBe(b);
  });

  it('ignores incidental whitespace differences', () => {
    const a = buildFingerprintInput({ provider: 'x', destinationId: 'd', text: 'Hello  world\n', publishAt: at });
    const b = buildFingerprintInput({ provider: 'x', destinationId: 'd', text: 'Hello world', publishAt: at });

    expect(a).toBe(b);
  });

  it('ignores media ordering', () => {
    const a = buildFingerprintInput({
      provider: 'x',
      destinationId: 'd',
      mediaIds: ['med_1', 'med_2'],
      publishAt: at,
    });
    const b = buildFingerprintInput({
      provider: 'x',
      destinationId: 'd',
      mediaIds: ['med_2', 'med_1'],
      publishAt: at,
    });

    expect(a).toBe(b);
  });

  it('distinguishes different media', () => {
    const a = buildFingerprintInput({ provider: 'x', destinationId: 'd', mediaIds: ['med_1'], publishAt: at });
    const b = buildFingerprintInput({ provider: 'x', destinationId: 'd', mediaIds: ['med_9'], publishAt: at });

    expect(a).not.toBe(b);
  });

  it('respects a custom bucket width', () => {
    const a = buildFingerprintInput({
      provider: 'x',
      destinationId: 'd',
      text: 'Hi',
      publishAt: at,
      timeBucketSeconds: 60,
    });
    const b = buildFingerprintInput({
      provider: 'x',
      destinationId: 'd',
      text: 'Hi',
      publishAt: new Date('2026-08-07T05:17:30.000Z'),
      timeBucketSeconds: 60,
    });

    expect(a).not.toBe(b);
  });
});
