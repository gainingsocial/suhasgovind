import { FACET_LINK, FACET_MENTION, FACET_TAG } from './constants.js';

/**
 * Rich-text facets (https://docs.bsky.app/blog/create-post).
 *
 * Bluesky does not parse links out of post text. The post stores plain text plus a list of
 * "facets" — byte ranges annotated with what they are. Omit them and a URL renders as
 * inert grey text, which looks broken to anyone used to every other network.
 *
 * The part that bites: facet offsets are **UTF-8 byte** positions, not JavaScript string
 * indices. JavaScript strings are UTF-16, so `"héllo".indexOf(...)` and the byte offset
 * diverge the moment any non-ASCII character appears earlier in the post. Get it wrong and
 * the link highlight lands on the wrong characters — or the record is rejected outright
 * for an out-of-range index. Every offset here is therefore computed on the encoded bytes.
 */

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: ({ $type: string } & Record<string, unknown>)[];
}

const encoder = new TextEncoder();

/**
 * Count graphemes the way Bluesky's 300 limit does.
 *
 * `String.length` counts UTF-16 code units, so "👨‍👩‍👧‍👦" reports 11 while the user typed one
 * character. Using it would reject posts a third the length of the real limit.
 * `Intl.Segmenter` is available in Workers and in Node 18+.
 */
export function countGraphemes(text: string): number {
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;
  }
  // Code points are a closer approximation than UTF-16 units where Segmenter is absent —
  // it still splits emoji families, but never over-counts a plain BMP character.
  return [...text].length;
}

export function countUtf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Truncate to a grapheme budget without splitting a character.
 *
 * Slicing by index can cut an emoji in half and produce a lone surrogate, which is both
 * invalid UTF-8 and visibly broken.
 */
export function truncateGraphemes(text: string, maxGraphemes: number): string {
  if (countGraphemes(text) <= maxGraphemes) return text;

  if (typeof Intl?.Segmenter === 'function') {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
    return segments.slice(0, maxGraphemes).map((s) => s.segment).join('');
  }
  return [...text].slice(0, maxGraphemes).join('');
}

/**
 * URL detection.
 *
 * Deliberately conservative — only explicit http(s) schemes. Bluesky's own reference
 * implementation also matches bare domains, but a false positive there turns an ordinary
 * sentence containing "example.com" into a link the author never wrote, and an unwanted
 * link is worse than a missing one.
 *
 * The trailing-punctuation trim exists because "see https://example.com." should not link
 * the full stop.
 */
const URL_PATTERN = /https?:\/\/[^\s<>[\]{}|\\^`"']+/g;

/** `@handle.domain`. Handles are always domain-shaped in atproto, so a TLD is required. */
const MENTION_PATTERN = /(^|\s|\()(@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})/g;

/** `#tag`. No spaces, and not a bare `#`. */
const TAG_PATTERN = /(^|\s)(#[^\s#.,!?;:)\]}]+)/g;

/**
 * Byte offset of a UTF-16 index.
 *
 * Encoding the prefix is O(n) per lookup, which is irrelevant at 300 graphemes and much
 * harder to get wrong than incremental bookkeeping.
 */
function byteOffsetOf(text: string, utf16Index: number): number {
  return encoder.encode(text.slice(0, utf16Index)).length;
}

export interface DetectedMention {
  handle: string;
  byteStart: number;
  byteEnd: number;
}

/**
 * Find every facet that needs no network lookup: links and tags.
 *
 * Mentions are returned separately because turning `@alice.bsky.social` into a facet
 * requires resolving the handle to a DID, which is an HTTP call the caller may not want to
 * make during validation.
 */
export function detectFacets(text: string): { facets: Facet[]; mentions: DetectedMention[] } {
  const facets: Facet[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;

    // Trailing punctuation is almost always sentence punctuation rather than part of the
    // URL. Closing brackets are kept only when the URL opened one — Wikipedia links.
    let uri = match[0];
    while (/[.,;:!?]$/.test(uri)) uri = uri.slice(0, -1);
    if (uri.endsWith(')') && !uri.includes('(')) uri = uri.slice(0, -1);

    facets.push({
      index: {
        byteStart: byteOffsetOf(text, match.index),
        byteEnd: byteOffsetOf(text, match.index + uri.length),
      },
      features: [{ $type: FACET_LINK, uri }],
    });
  }

  for (const match of text.matchAll(TAG_PATTERN)) {
    if (match.index === undefined || !match[2]) continue;
    const start = match.index + (match[1]?.length ?? 0);

    facets.push({
      index: {
        byteStart: byteOffsetOf(text, start),
        byteEnd: byteOffsetOf(text, start + match[2].length),
      },
      // The stored tag excludes the leading '#', matching Bluesky's own behaviour.
      features: [{ $type: FACET_TAG, tag: match[2].slice(1) }],
    });
  }

  const mentions: DetectedMention[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (match.index === undefined || !match[2]) continue;
    const start = match.index + (match[1]?.length ?? 0);

    mentions.push({
      handle: match[2].slice(1),
      byteStart: byteOffsetOf(text, start),
      byteEnd: byteOffsetOf(text, start + match[2].length),
    });
  }

  return { facets, mentions };
}

/** Build a mention facet once its DID has been resolved. */
export function mentionFacet(mention: DetectedMention, did: string): Facet {
  return {
    index: { byteStart: mention.byteStart, byteEnd: mention.byteEnd },
    features: [{ $type: FACET_MENTION, did }],
  };
}
