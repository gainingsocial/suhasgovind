/**
 * Aspect-ratio arithmetic for the media fit planner (plan §63E).
 *
 * Split out because ratio comparison is where a fit planner is most likely to be subtly
 * wrong, and where being wrong is expensive: a ratio judged non-compliant by a rounding
 * error produces a crop nobody asked for, and one judged compliant by the same error
 * produces a provider rejection after the user has already been told the post is fine.
 */

export interface AspectRatio {
  readonly width: number;
  readonly height: number;
  /** `width / height`. 1.777… for 16:9. */
  readonly value: number;
  /** Canonical `w:h` label, as platforms document them. */
  readonly label: string;
}

/**
 * Parse a `w:h` label.
 *
 * Returns null rather than throwing, and rather than defaulting to 1:1. A capability
 * document carrying a malformed ratio is a data fault, and silently treating it as square
 * would crop every image on that platform to a shape nobody specified (Rule 14).
 */
export function parseAspectRatio(label: string): AspectRatio | null {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(label.trim());
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  return { width, height, value: width / height, label: `${match[1]}:${match[2]}` };
}

/**
 * The tolerance within which a ratio counts as matching.
 *
 * Platforms specify ratios as clean fractions but accept a band around them, and real
 * images rarely land exactly: a 1080×1349 image is Instagram's documented 4:5 portrait,
 * yet 1080/1349 is 0.8006, not 0.8. A strict equality check would "fix" the platform's own
 * recommended dimensions.
 *
 * 1% is wide enough to absorb that and every similar rounding, and far narrower than the
 * gap between any two ratios a platform actually offers — 4:5 and 1:1 differ by 25%.
 */
export const ASPECT_RATIO_TOLERANCE = 0.01;

export function ratioMatches(actual: number, target: AspectRatio, tolerance = ASPECT_RATIO_TOLERANCE): boolean {
  return Math.abs(actual - target.value) <= target.value * tolerance;
}

/**
 * The supported ratio closest to what the media already is.
 *
 * Closest by *relative* difference, not absolute. An absolute comparison is dominated by
 * the wide end of the range — 16:9 (1.78) and 9:16 (0.5625) sit 1.22 apart while 4:5 (0.8)
 * and 1:1 sit 0.2 apart — so a portrait image would be judged "closer" to square than a
 * landscape one is to 16:9, and would be cropped when the landscape was left alone.
 */
export function nearestRatio(
  actual: number,
  supported: readonly AspectRatio[],
): AspectRatio | null {
  let best: AspectRatio | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of supported) {
    const distance = Math.abs(Math.log(actual / candidate.value));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best;
}

/**
 * The largest centred rectangle of `target` ratio that fits inside `width`×`height`.
 *
 * This is the crop a fit plan proposes. It never scales up, so no pixels are invented —
 * plan §63E forbids inserting AI-generated content without an explicit request, and
 * upscaling to reach a ratio is a mild form of exactly that.
 */
export function centredCrop(
  width: number,
  height: number,
  target: AspectRatio,
): { width: number; height: number; x: number; y: number } {
  const current = width / height;

  // Too wide for the target: keep full height, trim the sides.
  if (current > target.value) {
    const cropWidth = Math.round(height * target.value);
    return { width: cropWidth, height, x: Math.round((width - cropWidth) / 2), y: 0 };
  }

  // Too tall: keep full width, trim top and bottom.
  const cropHeight = Math.round(width / target.value);
  return { width, height: cropHeight, x: 0, y: Math.round((height - cropHeight) / 2) };
}

/**
 * How much of the frame a crop to `target` would discard, as a fraction of area.
 *
 * The number that decides whether a crop is safe to apply automatically. Trimming 2% off
 * the sides of a photo is invisible; trimming 45% is an editorial decision about what the
 * picture is of, and belongs to whoever composed it.
 */
export function cropLoss(width: number, height: number, target: AspectRatio): number {
  const crop = centredCrop(width, height, target);
  const kept = (crop.width * crop.height) / (width * height);
  return 1 - kept;
}
