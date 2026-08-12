import type { CapabilityConstraints, MediaKind } from '@gs/contracts/capabilities';

import {
  centredCrop,
  cropLoss,
  nearestRatio,
  parseAspectRatio,
  ratioMatches,
  type AspectRatio,
} from './aspect-ratio.js';

/**
 * Smart Media Auto-Fit — the decision half (plan §63E, P16, P17).
 *
 * Answers one question per media item per destination: *can this be published as it is,
 * and if not, what would we have to do to it, and are we allowed to do that without
 * asking?*
 *
 * Deliberately pure. It plans; it does not transform. Deciding what a platform requires is
 * knowledge, and knowledge belongs where it can be unit-tested exhaustively against every
 * documented limit — not inside a transcoding service where each assertion costs a
 * subprocess. The media service later executes these plans; it does not re-derive them.
 *
 * The governing rule (plan §63E): **never silently make an editorial change.** Technical
 * transcoding that preserves the content may be automatic. Removing content, changing
 * words, inserting generated pixels, altering playback speed or muting audio may not be —
 * not even when it would make the post succeed. A post that publishes with the subject
 * cropped out is worse than one that does not publish.
 */

/**
 * How a media item can be brought into spec, in increasing order of consent required
 * (plan §63E).
 */
export type FitDecision =
  /** Already compliant. Publish the bytes as they are. */
  | 'PASS'
  /**
   * A transform that cannot change what the media is *of*: format conversion, a quality
   * pass, a downscale, a trivial crop. Applied automatically (P17).
   */
  | 'SAFE_AUTOFIX'
  /**
   * A transform we can do and that a reasonable person might still object to — a crop that
   * discards a meaningful part of the frame. Offered, and applied only on confirmation.
   */
  | 'REVIEW_AUTOFIX'
  /**
   * Several valid answers exist and only the author can choose — which part of a long
   * video to keep, whether to letterbox or crop.
   */
  | 'USER_DECISION_REQUIRED'
  /** No transform makes this publishable here. */
  | 'UNSUPPORTED';

/** Severity ordering, so a plan's overall decision is the worst of its parts. */
const DECISION_RANK: Record<FitDecision, number> = {
  PASS: 0,
  SAFE_AUTOFIX: 1,
  REVIEW_AUTOFIX: 2,
  USER_DECISION_REQUIRED: 3,
  UNSUPPORTED: 4,
};

export function worstDecision(decisions: readonly FitDecision[]): FitDecision {
  return decisions.reduce<FitDecision>(
    (worst, current) => (DECISION_RANK[current] > DECISION_RANK[worst] ? current : worst),
    'PASS',
  );
}

export type TransformKind =
  | 'convert_format'
  | 'resize'
  | 'crop'
  | 'pad'
  | 'compress'
  | 'trim_duration'
  | 'generate_thumbnail';

export interface PlannedTransform {
  readonly kind: TransformKind;
  readonly decision: FitDecision;
  /** Plain-language, aimed at whoever has to approve it. */
  readonly reason: string;
  /** Everything the media service needs to execute this step. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface MediaFitInput {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
}

export interface MediaFitPlan {
  readonly mediaId: string;
  readonly decision: FitDecision;
  readonly transforms: readonly PlannedTransform[];
  /** Why this cannot be published here at all. Present only for `UNSUPPORTED`. */
  readonly blockedReason: string | null;
  /**
   * Stable identity of this plan, for variant caching (plan §33, §63E).
   *
   * Derived from the source media and the transforms — not from the destination. Two
   * destinations demanding the same 1:1 JPEG under 5 MB must reuse one variant rather than
   * transcode the same file twice, which is the entire point of caching by
   * source-plus-specification.
   */
  readonly variantKey: string | null;
}

/**
 * A crop discarding more than this is an editorial decision, not a technical one.
 *
 * 12% is roughly the difference between 16:9 and 3:2 — the kind of gap a photographer
 * would not notice. Past it, a crop starts deciding what the picture is of: at 25% a
 * landscape group photo loses the people at the edges, and nobody asked us to choose which
 * ones.
 */
export const SAFE_CROP_LOSS = 0.12;

/**
 * Source formats the transform pipeline can decode.
 *
 * An allow-list, not a deny-list. A format absent from here is refused with a clear
 * instruction rather than attempted, because the alternative — promising a conversion and
 * discovering at transcode time that nothing can open the file — reports the problem after
 * the author has been told the post is fine (Rule 14).
 *
 * Every entry is a format ffmpeg and a standard image toolchain read without a bespoke
 * codec. Adding one is a deliberate act, taken once the pipeline can genuinely handle it.
 */
export const DECODABLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/bmp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/3gpp',
]);

/**
 * Plan how to fit one media item to one destination's constraints.
 *
 * Order matters. Format and size are technical and settled first, because a plan that
 * proposes cropping a file the platform cannot read in any shape has wasted the reader's
 * attention on the wrong problem.
 */
export function planMediaFit(
  media: MediaFitInput,
  constraints: CapabilityConstraints,
): MediaFitPlan {
  const transforms: PlannedTransform[] = [];

  const blocked = (reason: string): MediaFitPlan => ({
    mediaId: media.mediaId,
    decision: 'UNSUPPORTED',
    transforms: [],
    blockedReason: reason,
    variantKey: null,
  });

  // ---- format -------------------------------------------------------------
  const supportedTypes =
    media.kind === 'video' ? constraints.supported_video_types : constraints.supported_image_types;

  if (supportedTypes.length > 0 && !supportedTypes.includes(media.mimeType)) {
    /**
     * Can we read the source at all?
     *
     * Checked before promising a conversion, because "convert it" is only an answer when
     * the input can actually be decoded. Without this the planner would cheerfully report
     * `SAFE_AUTOFIX` for a format nothing in the pipeline can open, and the failure would
     * surface at transcode time — after the author had been told the post was fine
     * (Rule 14).
     */
    if (!DECODABLE_SOURCE_TYPES.has(media.mimeType)) {
      return blocked(
        `${media.mimeType} cannot be converted to any format this platform accepts ` +
          `(${supportedTypes.join(', ')}). Re-export the file as one of those and upload it again.`,
      );
    }

    const target = preferredType(media.kind, supportedTypes);

    if (!target) {
      return blocked(
        `This platform accepts ${supportedTypes.join(', ')}, and none of those can be produced from ${media.mimeType}.`,
      );
    }

    transforms.push({
      kind: 'convert_format',
      // Container and codec changes preserve every pixel and every frame. Nothing about
      // what the media shows changes, so no one needs to be asked.
      decision: 'SAFE_AUTOFIX',
      reason: `This platform does not accept ${media.mimeType}; converting to ${target}.`,
      parameters: { from: media.mimeType, to: target },
    });
  }

  // ---- duration -----------------------------------------------------------
  if (media.kind === 'video' && media.durationSeconds !== null) {
    const { min_video_duration_seconds: min, max_video_duration_seconds: max } = constraints;

    if (min !== null && media.durationSeconds < min) {
      // Nothing to add. Padding a video with black frames to reach a minimum is inventing
      // content, which §63E forbids outright.
      return blocked(
        `This platform requires at least ${min}s of video; this clip is ${Math.round(media.durationSeconds)}s.`,
      );
    }

    if (max !== null && media.durationSeconds > max) {
      transforms.push({
        kind: 'trim_duration',
        /**
         * Never automatic. Trimming decides which part of the video the audience sees, and
         * "the first N seconds" is a guess about intent that is wrong as often as it is
         * right — the point of a clip is frequently at the end.
         */
        decision: 'USER_DECISION_REQUIRED',
        reason: `This platform allows ${max}s; this clip is ${Math.round(media.durationSeconds)}s. Choose which section to publish.`,
        parameters: { maxSeconds: max, currentSeconds: media.durationSeconds },
      });
    }
  }

  // ---- aspect ratio -------------------------------------------------------
  const ratios = constraints.supported_aspect_ratios
    .map(parseAspectRatio)
    .filter((ratio): ratio is AspectRatio => ratio !== null);

  if (ratios.length > 0 && media.width && media.height) {
    const actual = media.width / media.height;

    if (!ratios.some((ratio) => ratioMatches(actual, ratio))) {
      const target = nearestRatio(actual, ratios);

      if (target) {
        const loss = cropLoss(media.width, media.height, target);
        const crop = centredCrop(media.width, media.height, target);

        transforms.push({
          kind: 'crop',
          /**
           * The judgement call this whole module exists to make. A crop losing a sliver is
           * technical; one losing a quarter of the frame is a decision about what the
           * picture is of, and belongs to whoever took it.
           */
          decision: loss <= SAFE_CROP_LOSS ? 'SAFE_AUTOFIX' : 'REVIEW_AUTOFIX',
          reason:
            loss <= SAFE_CROP_LOSS
              ? `Cropping to ${target.label}, losing ${formatPercent(loss)} of the frame.`
              : `This platform needs ${target.label}. A centred crop would lose ${formatPercent(loss)} of the frame — review it, or supply a focal point.`,
          parameters: {
            targetRatio: target.label,
            crop,
            lossFraction: Number(loss.toFixed(4)),
            // Named so a caller knows the alternative exists without reading our docs.
            alternative: 'pad',
          },
        });
      }
    }
  }

  // ---- file size ----------------------------------------------------------
  const maxBytes =
    media.kind === 'video' ? constraints.max_video_bytes : constraints.max_image_bytes;

  if (maxBytes !== null && media.bytes > maxBytes) {
    /**
     * Ordering note: a crop or a format change already shrinks the file, so this is only
     * reached when the media is over the limit *after* those. Planning compression before
     * them would over-compress, and quality lost to a redundant pass does not come back.
     */
    transforms.push({
      kind: 'compress',
      // Re-encoding at lower quality is technical: the content is identical, only the
      // fidelity changes, and the alternative is not publishing at all.
      decision: 'SAFE_AUTOFIX',
      reason: `This platform allows ${formatBytes(maxBytes)}; this file is ${formatBytes(media.bytes)}. Re-encoding to fit.`,
      parameters: { maxBytes, currentBytes: media.bytes },
    });
  }

  const decision = worstDecision(transforms.map((transform) => transform.decision));

  return {
    mediaId: media.mediaId,
    decision,
    transforms,
    blockedReason: null,
    variantKey: transforms.length > 0 ? variantKeyFor(media, transforms) : null,
  };
}

/**
 * Which supported type to convert to.
 *
 * Preference order rather than "the first one listed", because a capability document lists
 * what a platform accepts in no particular order, and picking arbitrarily could turn a
 * photograph into a PNG — lossless, several times larger, and straight back over the size
 * limit the next check enforces.
 */
function preferredType(kind: MediaKind, supported: readonly string[]): string | null {
  const preference =
    kind === 'video'
      ? ['video/mp4', 'video/quicktime', 'video/webm']
      : ['image/jpeg', 'image/png', 'image/webp'];

  return preference.find((type) => supported.includes(type)) ?? supported[0] ?? null;
}

/**
 * Cache key for the variant a plan produces (plan §33).
 *
 * Covers the source media and every transform parameter, and nothing about the
 * destination. Two platforms wanting the same 1:1 JPEG under 5 MB get one transcode
 * between them — which is the whole reason variants are cached by source-plus-spec rather
 * than by destination.
 */
export function variantKeyFor(
  media: MediaFitInput,
  transforms: readonly PlannedTransform[],
): string {
  const spec = transforms
    .map((transform) => `${transform.kind}:${stableStringify(transform.parameters)}`)
    .sort()
    .join('|');

  return `${media.mediaId}|${media.mimeType}|${media.bytes}|${spec}`;
}

/** Key-sorted JSON, so two identical parameter objects always produce one key. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

/**
 * Plan a whole post's media for one destination.
 *
 * The count check lives here rather than in `planMediaFit` because it is a property of the
 * set, not of any one item — and because dropping media to fit a limit is never something
 * to do quietly. Which three of five photographs to publish is the author's call.
 */
export interface PostMediaFitPlan {
  readonly decision: FitDecision;
  readonly items: readonly MediaFitPlan[];
  readonly findings: readonly { code: string; message: string; decision: FitDecision }[];
}

export function planPostMediaFit(
  media: readonly MediaFitInput[],
  constraints: CapabilityConstraints,
): PostMediaFitPlan {
  const items = media.map((item) => planMediaFit(item, constraints));
  const findings: { code: string; message: string; decision: FitDecision }[] = [];

  const max = constraints.max_media_count;
  if (max !== null && media.length > max) {
    findings.push({
      code: 'MEDIA_COUNT_EXCEEDED',
      message: `This platform accepts ${max} item${max === 1 ? '' : 's'}; the post has ${media.length}. Choose which to publish here.`,
      decision: 'USER_DECISION_REQUIRED',
    });
  }

  return {
    decision: worstDecision([
      ...items.map((item) => item.decision),
      ...findings.map((finding) => finding.decision),
    ]),
    items,
    findings,
  };
}
