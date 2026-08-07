/**
 * Target content resolution (plan §11.2, ADR-008).
 *
 * The order is fixed and identical in preflight and in publish. If these two ever
 * diverged, preflight would validate something other than what gets published — which
 * would make the product's central promise false.
 *
 *   canonical post content
 *     → target content override
 *       → provider-specific options
 *         → provider capability / default resolver
 */

export interface PostContent {
  text?: string;
  media_ids?: string[];
  link?: string;
  [key: string]: unknown;
}

export interface TargetOverrides {
  text?: string;
  media_ids?: string[];
  link?: string;
  [key: string]: unknown;
}

/** `{ instagram: { type: 'reel' } }` at the REST boundary (plan §11.3). */
export type ProviderOptionsMap = Record<string, Record<string, unknown>>;

export interface ResolveContentInput {
  canonical: PostContent;
  overrides?: TargetOverrides | null;
  options?: ProviderOptionsMap | null;
  provider: string;
}

export interface ResolvedTargetContent {
  text?: string;
  media_ids: string[];
  link?: string;
  /** Options for THIS provider only, already narrowed from the map. */
  options: Record<string, unknown>;
  /** Extra canonical fields that survived resolution, for adapters that use them. */
  extra: Record<string, unknown>;
}

const RESERVED_CONTENT_KEYS = new Set(['text', 'media_ids', 'link']);

/**
 * Merge canonical content with a target's overrides and narrow provider options.
 *
 * Overrides REPLACE rather than merge. An override of `media_ids: []` means "publish this
 * one without media", which a deep merge would silently turn into "keep the canonical
 * media" — the opposite of what the customer asked for. `undefined` means "not
 * overridden"; an explicit empty array means "empty".
 */
export function resolveTargetContent(input: ResolveContentInput): ResolvedTargetContent {
  const overrides = input.overrides ?? {};

  const text = overrides.text !== undefined ? overrides.text : input.canonical.text;
  const mediaIds =
    overrides.media_ids !== undefined ? overrides.media_ids : (input.canonical.media_ids ?? []);
  const link = overrides.link !== undefined ? overrides.link : input.canonical.link;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.canonical)) {
    if (!RESERVED_CONTENT_KEYS.has(key)) extra[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!RESERVED_CONTENT_KEYS.has(key)) extra[key] = value;
  }

  return {
    ...(text !== undefined ? { text } : {}),
    media_ids: [...(mediaIds ?? [])],
    ...(link !== undefined ? { link } : {}),
    options: input.options?.[input.provider] ?? {},
    extra,
  };
}

/**
 * Canonicalize a request body for idempotency hashing (ADR-006 Layer 1).
 *
 * Object key order must not affect the hash: two JSON serializations of the same logical
 * request are the same request, and a client library that reorders keys between retries
 * must not be told its `Idempotency-Key` was reused with a different body.
 *
 * Array order IS preserved — `targets` order is meaningful, and media order determines
 * carousel sequence.
 */
export function canonicalizeForHashing(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    // Dropping undefined matches JSON semantics: `{a: undefined}` and `{}` serialize
    // identically, so they must hash identically too.
    if (entry !== undefined) sorted[key] = sortValue(entry);
  }
  return sorted;
}

export interface FingerprintInput {
  provider: string;
  destinationId: string;
  text?: string;
  mediaIds?: readonly string[];
  link?: string;
  publishAt?: Date | null;
  /** Bucket width for the time component. Default 1 hour. */
  timeBucketSeconds?: number;
}

/**
 * Build the content-fingerprint input string (ADR-006 Layer 3).
 *
 * Advisory duplicate detection, not a hard constraint — customers legitimately repost.
 * The time bucket means "the same content to the same place at roughly the same time",
 * which catches a double-submitted form without blocking a genuine weekly repost.
 *
 * Returns the string to hash; hashing itself lives in `@gs/crypto` so this stays pure.
 */
export function buildFingerprintInput(input: FingerprintInput): string {
  const bucketSeconds = input.timeBucketSeconds ?? 3600;
  const at = input.publishAt ?? new Date();
  const bucket = Math.floor(at.getTime() / 1000 / bucketSeconds);

  // Whitespace is normalized so a stray trailing newline is not treated as new content.
  const normalizedText = (input.text ?? '').trim().replace(/\s+/g, ' ');
  const media = [...(input.mediaIds ?? [])].sort().join(',');

  return [
    'gs.fingerprint.v1',
    input.provider,
    input.destinationId,
    normalizedText,
    media,
    input.link ?? '',
    String(bucket),
  ].join('|');
}
