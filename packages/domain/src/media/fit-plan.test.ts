import type { CapabilityConstraints } from '@gs/contracts/capabilities';
import { describe, expect, it } from 'vitest';

import { centredCrop, cropLoss, nearestRatio, parseAspectRatio, ratioMatches } from './aspect-ratio.js';
import {
  SAFE_CROP_LOSS,
  planMediaFit,
  planPostMediaFit,
  variantKeyFor,
  worstDecision,
  type MediaFitInput,
} from './fit-plan.js';

/**
 * Smart Media Auto-Fit decisions (plan §63E).
 *
 * These assertions are about consent as much as correctness. The line between
 * `SAFE_AUTOFIX` and `REVIEW_AUTOFIX` decides whether somebody's photograph gets cropped
 * without being asked, and the difference between a good product and an infuriating one is
 * exactly where that line sits.
 */

const constraints = (overrides: Partial<CapabilityConstraints> = {}): CapabilityConstraints => ({
  max_text_length: 2_200,
  max_media_count: 10,
  max_image_bytes: 8_000_000,
  max_video_bytes: 100_000_000,
  max_video_duration_seconds: 60,
  min_video_duration_seconds: 3,
  supported_image_types: ['image/jpeg', 'image/png'],
  supported_video_types: ['video/mp4'],
  supported_aspect_ratios: ['1:1', '4:5', '16:9'],
  max_hashtags: 30,
  max_mentions: 20,
  allowed_privacy_levels: [],
  supports_alt_text: true,
  ...overrides,
});

const image = (overrides: Partial<MediaFitInput> = {}): MediaFitInput => ({
  mediaId: 'med_1',
  kind: 'image',
  mimeType: 'image/jpeg',
  bytes: 1_000_000,
  width: 1080,
  height: 1080,
  durationSeconds: null,
  ...overrides,
});

const video = (overrides: Partial<MediaFitInput> = {}): MediaFitInput => ({
  mediaId: 'med_v',
  kind: 'video',
  mimeType: 'video/mp4',
  bytes: 20_000_000,
  width: 1920,
  height: 1080,
  durationSeconds: 30,
  ...overrides,
});

describe('aspect ratio arithmetic', () => {
  it('parses a documented ratio label', () => {
    expect(parseAspectRatio('16:9')).toMatchObject({ width: 16, height: 9, label: '16:9' });
  });

  it('refuses a malformed label rather than defaulting to square', () => {
    // A capability document with a bad ratio is a data fault. Treating it as 1:1 would
    // crop every image on that platform to a shape nobody specified.
    for (const bad of ['', 'square', '16/9', '16:', ':9', '0:1', '-1:2']) {
      expect(parseAspectRatio(bad)).toBeNull();
    }
  });

  it('accepts a platform’s own recommended dimensions as matching', () => {
    // 1080×1349 is Instagram's documented 4:5 portrait, and 1080/1349 is 0.8006, not 0.8.
    // A strict equality check would "fix" the platform's own recommendation.
    const fourFive = parseAspectRatio('4:5')!;
    expect(ratioMatches(1080 / 1349, fourFive)).toBe(true);
  });

  it('does not treat two genuinely different ratios as matching', () => {
    const square = parseAspectRatio('1:1')!;
    expect(ratioMatches(4 / 5, square)).toBe(false);
    expect(ratioMatches(16 / 9, square)).toBe(false);
  });

  it('picks the nearest ratio by relative distance, not absolute', () => {
    const ratios = ['1:1', '4:5', '16:9'].map((label) => parseAspectRatio(label)!);

    // A 3:2 landscape is closer to 16:9 than to square, even though the absolute gap to
    // square (0.5) looks smaller than the gap to 16:9 (0.28) on a naive comparison of the
    // wide end of the range.
    expect(nearestRatio(3 / 2, ratios)?.label).toBe('16:9');
    // And a portrait picture goes to the portrait ratio, not to square.
    expect(nearestRatio(0.78, ratios)?.label).toBe('4:5');
  });

  it('crops from the centre and never scales up', () => {
    const square = parseAspectRatio('1:1')!;
    const crop = centredCrop(1920, 1080, square);

    expect(crop).toEqual({ width: 1080, height: 1080, x: 420, y: 0 });
    expect(crop.width).toBeLessThanOrEqual(1920);
    expect(crop.height).toBeLessThanOrEqual(1080);
  });

  it('crops the other axis for a too-tall image', () => {
    const square = parseAspectRatio('1:1')!;
    expect(centredCrop(1080, 1920, square)).toEqual({ width: 1080, height: 1080, x: 0, y: 420 });
  });

  it('reports zero loss when the media is already the target ratio', () => {
    expect(cropLoss(1080, 1080, parseAspectRatio('1:1')!)).toBeCloseTo(0, 5);
  });

  it('reports the fraction of the frame a crop discards', () => {
    // 1920×1080 to square keeps 1080 of 1920 columns — 43.75% is lost.
    expect(cropLoss(1920, 1080, parseAspectRatio('1:1')!)).toBeCloseTo(0.4375, 3);
  });
});

describe('planMediaFit — compliant media', () => {
  it('passes media that already meets every constraint', () => {
    const plan = planMediaFit(image(), constraints());

    expect(plan.decision).toBe('PASS');
    expect(plan.transforms).toHaveLength(0);
    // Nothing to transform means nothing to cache.
    expect(plan.variantKey).toBeNull();
  });

  it('passes when the platform constrains nothing', () => {
    const plan = planMediaFit(
      image({ mimeType: 'image/heic', width: 3000, height: 700, bytes: 50_000_000 }),
      constraints({
        supported_image_types: [],
        supported_aspect_ratios: [],
        max_image_bytes: null,
      }),
    );

    expect(plan.decision).toBe('PASS');
  });
});

describe('planMediaFit — technical fixes are automatic (P17)', () => {
  it('converts an unsupported format without asking', () => {
    // Every pixel survives a container change, so there is nothing to consent to.
    const plan = planMediaFit(image({ mimeType: 'image/heic' }), constraints());

    expect(plan.decision).toBe('SAFE_AUTOFIX');
    expect(plan.transforms[0]).toMatchObject({
      kind: 'convert_format',
      decision: 'SAFE_AUTOFIX',
      parameters: { from: 'image/heic', to: 'image/jpeg' },
    });
  });

  it('prefers JPEG over PNG for a photograph', () => {
    // Picking arbitrarily from the supported list could turn a photo into a lossless PNG
    // several times larger — straight back over the size limit checked moments later.
    const plan = planMediaFit(
      image({ mimeType: 'image/heic' }),
      constraints({ supported_image_types: ['image/png', 'image/jpeg'] }),
    );

    expect(plan.transforms[0]?.parameters).toMatchObject({ to: 'image/jpeg' });
  });

  it('compresses an oversized file without asking', () => {
    const plan = planMediaFit(image({ bytes: 20_000_000 }), constraints());

    expect(plan.decision).toBe('SAFE_AUTOFIX');
    expect(plan.transforms).toMatchObject([{ kind: 'compress', decision: 'SAFE_AUTOFIX' }]);
  });

  it('applies a negligible crop without asking', () => {
    // 1080×1000 is 1.08:1 — a sliver off one axis to reach square. Nobody would notice,
    // and asking about it would train people to click through the ones that matter.
    const plan = planMediaFit(image({ width: 1080, height: 1000 }), constraints());

    expect(plan.decision).toBe('SAFE_AUTOFIX');
    expect(plan.transforms[0]).toMatchObject({ kind: 'crop', decision: 'SAFE_AUTOFIX' });
    expect(
      Number((plan.transforms[0]?.parameters as { lossFraction: number }).lossFraction),
    ).toBeLessThanOrEqual(SAFE_CROP_LOSS);
  });
});

describe('planMediaFit — editorial changes need consent (§63E)', () => {
  it('asks before a crop that discards a meaningful part of the frame', () => {
    // 1920×1080 to square loses 44%. That decides what the picture is of, and the person
    // who took it gets to make that call.
    const plan = planMediaFit(
      image({ width: 1920, height: 1080 }),
      constraints({ supported_aspect_ratios: ['1:1'] }),
    );

    expect(plan.decision).toBe('REVIEW_AUTOFIX');
    expect(plan.transforms[0]).toMatchObject({ kind: 'crop', decision: 'REVIEW_AUTOFIX' });
  });

  it('offers padding as the alternative to cropping', () => {
    const plan = planMediaFit(
      image({ width: 1920, height: 1080 }),
      constraints({ supported_aspect_ratios: ['1:1'] }),
    );

    expect(plan.transforms[0]?.parameters).toMatchObject({ alternative: 'pad' });
  });

  it('never trims a video automatically', () => {
    // "The first sixty seconds" is a guess about intent that is wrong as often as it is
    // right — the point of a clip is frequently at the end.
    const plan = planMediaFit(video({ durationSeconds: 180 }), constraints());

    expect(plan.decision).toBe('USER_DECISION_REQUIRED');
    expect(plan.transforms).toMatchObject([
      { kind: 'trim_duration', decision: 'USER_DECISION_REQUIRED' },
    ]);
  });

  it('never pads a video to reach a minimum duration', () => {
    // Padding with black frames is inventing content, which §63E forbids outright.
    const plan = planMediaFit(video({ durationSeconds: 1 }), constraints());

    expect(plan.decision).toBe('UNSUPPORTED');
    expect(plan.blockedReason).toContain('at least 3s');
    expect(plan.transforms).toHaveLength(0);
  });
});

describe('planMediaFit — genuinely impossible', () => {
  it('refuses a source format nothing in the pipeline can decode', () => {
    // The alternative is promising a conversion and discovering at transcode time that
    // nothing can open the file — after the author has been told the post is fine.
    const plan = planMediaFit(image({ mimeType: 'image/x-adobe-dng' }), constraints());

    expect(plan.decision).toBe('UNSUPPORTED');
    expect(plan.blockedReason).toContain('cannot be converted');
    // And it says what to do about it, rather than only that it failed.
    expect(plan.blockedReason).toContain('Re-export');
    expect(plan.transforms).toHaveLength(0);
  });

  it('converts a decodable container the platform happens not to accept', () => {
    const plan = planMediaFit(
      video({ mimeType: 'video/x-matroska' }),
      constraints({ supported_video_types: ['video/mp4'] }),
    );

    // mp4 is producible from Matroska, so converting is the honest answer, not blocking.
    expect(plan.decision).toBe('SAFE_AUTOFIX');
    expect(plan.transforms[0]).toMatchObject({
      kind: 'convert_format',
      parameters: { to: 'video/mp4' },
    });
  });

  it('does not check decodability when the platform accepts the format as-is', () => {
    // An exotic format a platform explicitly supports is published untouched — we never
    // needed to decode it, so our own pipeline's limits are irrelevant.
    const plan = planMediaFit(
      image({ mimeType: 'image/x-adobe-dng' }),
      constraints({ supported_image_types: ['image/x-adobe-dng'] }),
    );

    expect(plan.decision).toBe('PASS');
  });
});

describe('planMediaFit — ordering', () => {
  it('plans format, then ratio, then size', () => {
    // Compression comes last because a crop and a format change already shrink the file.
    // Planning it first would over-compress, and quality lost to a redundant pass does not
    // come back.
    const plan = planMediaFit(
      image({ mimeType: 'image/heic', width: 1920, height: 1080, bytes: 30_000_000 }),
      constraints({ supported_aspect_ratios: ['1:1'] }),
    );

    expect(plan.transforms.map((transform) => transform.kind)).toEqual([
      'convert_format',
      'crop',
      'compress',
    ]);
  });

  it('takes the worst decision across every transform', () => {
    const plan = planMediaFit(
      image({ mimeType: 'image/heic', width: 1920, height: 1080 }),
      constraints({ supported_aspect_ratios: ['1:1'] }),
    );

    // A safe format conversion alongside a reviewable crop is still reviewable.
    expect(plan.decision).toBe('REVIEW_AUTOFIX');
  });
});

describe('variant caching (plan §33)', () => {
  it('gives two destinations wanting the same output one cache key', () => {
    // The whole point of caching by source-plus-specification: Instagram and Facebook both
    // wanting a 1:1 JPEG must not transcode the same file twice.
    const source = image({ mimeType: 'image/heic', width: 1920, height: 1080 });
    const square = constraints({ supported_aspect_ratios: ['1:1'] });

    const a = planMediaFit(source, square);
    const b = planMediaFit(source, constraints({ supported_aspect_ratios: ['1:1'], max_media_count: 1 }));

    expect(a.variantKey).toBe(b.variantKey);
    expect(a.variantKey).not.toBeNull();
  });

  it('gives different outputs different keys', () => {
    const source = image({ mimeType: 'image/heic', width: 1920, height: 1080 });

    const square = planMediaFit(source, constraints({ supported_aspect_ratios: ['1:1'] }));
    const portrait = planMediaFit(source, constraints({ supported_aspect_ratios: ['4:5'] }));

    expect(square.variantKey).not.toBe(portrait.variantKey);
  });

  it('is stable regardless of parameter insertion order', () => {
    const media = image();
    const a = variantKeyFor(media, [
      { kind: 'crop', decision: 'SAFE_AUTOFIX', reason: '', parameters: { a: 1, b: 2 } },
    ]);
    const b = variantKeyFor(media, [
      { kind: 'crop', decision: 'SAFE_AUTOFIX', reason: '', parameters: { b: 2, a: 1 } },
    ]);

    expect(a).toBe(b);
  });
});

describe('planPostMediaFit', () => {
  it('never silently drops media to fit a count limit', () => {
    // Which three of five photographs to publish is the author's call, always.
    const plan = planPostMediaFit(
      [image({ mediaId: 'a' }), image({ mediaId: 'b' }), image({ mediaId: 'c' })],
      constraints({ max_media_count: 1 }),
    );

    expect(plan.decision).toBe('USER_DECISION_REQUIRED');
    expect(plan.findings).toMatchObject([{ code: 'MEDIA_COUNT_EXCEEDED' }]);
    // And the individual items are still planned, so the caller can see what each needs.
    expect(plan.items).toHaveLength(3);
  });

  it('reports the worst decision across every item', () => {
    const plan = planPostMediaFit(
      [image(), image({ mediaId: 'wide', width: 1920, height: 1080 })],
      constraints({ supported_aspect_ratios: ['1:1'] }),
    );

    expect(plan.decision).toBe('REVIEW_AUTOFIX');
    expect(plan.items[0]?.decision).toBe('PASS');
  });

  it('passes a compliant post untouched', () => {
    const plan = planPostMediaFit([image(), image({ mediaId: 'b' })], constraints());

    expect(plan.decision).toBe('PASS');
    expect(plan.findings).toHaveLength(0);
  });
});

describe('worstDecision', () => {
  it('ranks decisions by how much consent they need', () => {
    expect(worstDecision([])).toBe('PASS');
    expect(worstDecision(['PASS', 'SAFE_AUTOFIX'])).toBe('SAFE_AUTOFIX');
    expect(worstDecision(['SAFE_AUTOFIX', 'REVIEW_AUTOFIX'])).toBe('REVIEW_AUTOFIX');
    expect(worstDecision(['REVIEW_AUTOFIX', 'USER_DECISION_REQUIRED'])).toBe(
      'USER_DECISION_REQUIRED',
    );
    expect(worstDecision(['USER_DECISION_REQUIRED', 'UNSUPPORTED'])).toBe('UNSUPPORTED');
  });
});
