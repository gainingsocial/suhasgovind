import type { CapabilityConstraints } from '@gs/contracts/capabilities';
import { describe, expect, it } from 'vitest';

import {
  extractHashtags,
  graphemeLength,
  planTextFit,
  stripTrailingHashtags,
  truncateAtBoundary,
} from './text-fit.js';

/**
 * Deterministic text adaptation (plan §63C).
 *
 * The line these tests defend: a change that preserves what the author wrote may be
 * automatic; a change that decides what it *says* may not. Nothing here rewrites or
 * rephrases — that belongs to Content Intelligence, where a person reviews it.
 */

const constraints = (overrides: Partial<CapabilityConstraints> = {}): CapabilityConstraints => ({
  max_text_length: 280,
  max_media_count: 4,
  max_image_bytes: 5_000_000,
  max_video_bytes: 100_000_000,
  max_video_duration_seconds: 140,
  min_video_duration_seconds: null,
  supported_image_types: ['image/jpeg'],
  supported_video_types: ['video/mp4'],
  supported_aspect_ratios: [],
  max_hashtags: 30,
  max_mentions: 10,
  allowed_privacy_levels: [],
  supports_alt_text: true,
  ...overrides,
});

describe('graphemeLength', () => {
  it('counts an emoji as one character, not two', () => {
    // A naive `.length` reads 2 for an astral-plane emoji, so a 280-character post full of
    // them would be rejected at 140 — visibly wrong to anyone who counted.
    expect(graphemeLength('🎉')).toBe(1);
    expect(graphemeLength('hi 🎉')).toBe(4);
  });
});

describe('truncateAtBoundary', () => {
  it('leaves text that already fits completely alone', () => {
    expect(truncateAtBoundary('short enough', 100)).toBe('short enough');
  });

  it('cuts at the end of a sentence when one is available', () => {
    const text = 'First sentence here. Second sentence follows and runs on for a while.';
    expect(truncateAtBoundary(text, 40)).toBe('First sentence here.');
  });

  it('falls back to a word boundary when no sentence ends in range', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const result = truncateAtBoundary(text, 20);

    expect(result).toBe('one two three four');
    // Never mid-word. "the annual confe" reads as a bug, not an edit.
    expect(text.startsWith(result)).toBe(true);
  });

  it('does not cut to a tiny opening sentence just because one exists', () => {
    // "Hi." followed by 200 characters is not a shorter post, it is a different one.
    const text = `Hi. ${'x'.repeat(200)}`;
    const result = truncateAtBoundary(text, 100);

    expect(result.length).toBeGreaterThan(50);
  });

  it('hard-cuts text with no boundary at all rather than publishing nothing', () => {
    const text = 'x'.repeat(500);
    expect(truncateAtBoundary(text, 100)).toHaveLength(100);
  });
});

describe('hashtag handling', () => {
  it('finds hashtags including non-Latin scripts', () => {
    expect(extractHashtags('launch day #product #新製品 #v2_0')).toEqual([
      '#product',
      '#新製品',
      '#v2_0',
    ]);
  });

  it('lifts only the trailing block, never one inside a sentence', () => {
    // "we're at #CES this week" is writing. Removing it leaves a hole mid-sentence.
    const { body, hashtags } = stripTrailingHashtags(
      "We're at #CES this week. Come say hello.\n\n#tech #launch",
    );

    expect(body).toBe("We're at #CES this week. Come say hello.");
    expect(hashtags).toEqual(['#tech', '#launch']);
  });

  it('leaves text with no trailing block untouched', () => {
    const text = 'Nothing to move here.';
    expect(stripTrailingHashtags(text)).toEqual({ body: text, hashtags: [] });
  });
});

describe('planTextFit — exact mode reports, never edits', () => {
  it('passes text that already fits', () => {
    const result = planTextFit({ text: 'Hello world', linkUrl: null, mode: 'exact' }, constraints());

    expect(result.decision).toBe('PASS');
    expect(result.text).toBe('Hello world');
    expect(result.adaptations).toHaveLength(0);
  });

  it('reports an over-length post without shortening it', () => {
    const text = 'x'.repeat(400);
    const result = planTextFit({ text, linkUrl: null, mode: 'exact' }, constraints());

    expect(result.decision).toBe('USER_DECISION_REQUIRED');
    // The text comes back exactly as supplied — exact mode changes nothing.
    expect(result.text).toBe(text);
  });
});

describe('planTextFit — optimize mode adapts what it safely can', () => {
  it('moves a trailing hashtag block that is over the limit', () => {
    const result = planTextFit(
      { text: 'Launch day.\n\n#a #b #c', linkUrl: null, mode: 'optimize', supportsFirstComment: true },
      constraints({ max_hashtags: 1 }),
    );

    expect(result.decision).toBe('SAFE_AUTOFIX');
    expect(result.text).toBe('Launch day.');
    expect(result.extractedHashtags).toEqual(['#a', '#b', '#c']);
    expect(result.adaptations[0]?.reason).toContain('first comment');
  });

  it('says removed rather than moved when there is no first comment', () => {
    const result = planTextFit(
      { text: 'Launch day.\n\n#a #b #c', linkUrl: null, mode: 'optimize' },
      constraints({ max_hashtags: 1 }),
    );

    expect(result.adaptations[0]?.reason).toContain('removed');
  });

  it('asks when the excess hashtags are woven through the writing', () => {
    // They cannot be removed without editing the sentences they are part of.
    const result = planTextFit(
      { text: 'At #CES with #partners seeing #robots today', linkUrl: null, mode: 'optimize' },
      constraints({ max_hashtags: 1 }),
    );

    expect(result.decision).toBe('USER_DECISION_REQUIRED');
    expect(result.text).toContain('#CES');
  });

  it('shortens for review rather than silently', () => {
    // Cutting at a boundary preserves the words that remain, but removes some — and the
    // removed part may be the point.
    const text = `${'word '.repeat(80)}end.`;
    const result = planTextFit({ text, linkUrl: null, mode: 'optimize' }, constraints());

    expect(result.decision).toBe('REVIEW_AUTOFIX');
    expect(graphemeLength(result.text)).toBeLessThanOrEqual(280);
    expect(result.adaptations[0]).toMatchObject({ kind: 'truncate' });
  });

  it('reserves room for a link that will be appended', () => {
    const link = 'https://example.com/a-fairly-long-path-to-the-announcement';
    const text = 'x'.repeat(270);

    const result = planTextFit({ text, linkUrl: link, mode: 'optimize' }, constraints());

    // 270 characters fits 280 on its own, but not once the link is counted.
    expect(result.decision).toBe('REVIEW_AUTOFIX');
    expect(graphemeLength(result.text) + graphemeLength(link) + 1).toBeLessThanOrEqual(280);
  });

  it('checks length after removing hashtags, since that may already have fixed it', () => {
    const body = 'x'.repeat(260);
    const result = planTextFit(
      { text: `${body}\n\n#one #two #three`, linkUrl: null, mode: 'optimize' },
      constraints({ max_hashtags: 0 }),
    );

    // Removing the block brought it under the limit, so no truncation was needed.
    expect(result.adaptations.map((a) => a.kind)).toEqual(['move_hashtags']);
    expect(result.decision).toBe('SAFE_AUTOFIX');
  });

  it('never drops mentions automatically, in either mode', () => {
    // A mention is a person. Deciding which people to remove is not formatting.
    for (const mode of ['exact', 'optimize'] as const) {
      const result = planTextFit(
        { text: '@ann @bob @cat @dan hello', linkUrl: null, mode },
        constraints({ max_mentions: 2 }),
      );

      expect(result.decision).toBe('USER_DECISION_REQUIRED');
      expect(result.text).toContain('@ann');
      expect(result.text).toContain('@dan');
    }
  });

  it('passes an unconstrained platform through untouched', () => {
    const text = `${'x'.repeat(5000)} #a #b #c @one @two`;
    const result = planTextFit(
      { text, linkUrl: null, mode: 'optimize' },
      constraints({ max_text_length: null, max_hashtags: null, max_mentions: null }),
    );

    expect(result.decision).toBe('PASS');
    expect(result.text).toBe(text);
  });

  it('reports the worst decision across several adaptations', () => {
    const result = planTextFit(
      { text: `${'word '.repeat(80)}\n\n#a #b`, linkUrl: null, mode: 'optimize' },
      constraints({ max_hashtags: 1 }),
    );

    // A safe hashtag move alongside a reviewable shortening is still reviewable.
    expect(result.decision).toBe('REVIEW_AUTOFIX');
  });
});
