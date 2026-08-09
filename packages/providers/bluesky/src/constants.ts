/**
 * Bluesky / AT Protocol limits, taken from the published Lexicon schemas.
 *
 * Sources (Rule 2 — never invent provider behaviour):
 *   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
 *   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json
 *   https://docs.bsky.app/blog/create-post
 *
 * These are the schema's own numbers, not observed behaviour. When Bluesky changes a
 * Lexicon, this file is the one place to update — and `ADAPTER_VERSION` should move with
 * it so an attempt record says which set of limits it was validated against (plan §44).
 */

export const ADAPTER_VERSION = '1.0.0';

/** Default Personal Data Server. A connection may override it — atproto is federated. */
export const DEFAULT_PDS = 'https://bsky.social';

/** Where a published post is viewable. Only for display; the canonical id is the AT-URI. */
export const APP_VIEW_BASE = 'https://bsky.app';

/**
 * Text limits.
 *
 * BOTH apply, and they measure different things. `maxGraphemes: 300` is what the app shows
 * users; `maxLength: 3000` is a byte ceiling on the UTF-8 encoding. A post of 300 emoji
 * passes the grapheme check and fails the byte check, so checking only the famous one
 * would let the provider reject a post preflight had approved.
 */
export const MAX_TEXT_GRAPHEMES = 300;
export const MAX_TEXT_BYTES = 3000;

/** `app.bsky.embed.images` — maxLength: 4. */
export const MAX_IMAGES = 4;

/**
 * Blob ceiling for images, 2,000,000 bytes.
 *
 * The Lexicon notes this was formerly 1 MB. Worth remembering: a PDS running an older
 * build may still enforce the old limit, so a rejection near this size is not necessarily
 * our validation being wrong.
 */
export const MAX_IMAGE_BYTES = 2_000_000;

/** `maxLength: 3` on the langs array. */
export const MAX_LANGS = 3;

/** Lexicon record and embed type identifiers. */
export const POST_COLLECTION = 'app.bsky.feed.post';
export const EMBED_IMAGES = 'app.bsky.embed.images';
export const EMBED_EXTERNAL = 'app.bsky.embed.external';
export const FACET_LINK = 'app.bsky.richtext.facet#link';
export const FACET_MENTION = 'app.bsky.richtext.facet#mention';
export const FACET_TAG = 'app.bsky.richtext.facet#tag';

/**
 * `image/*` per the Lexicon. Narrowed here to the formats Bluesky's own client produces,
 * because "image/*" would let us pass a TIFF that the app view then cannot render.
 */
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Endpoint paths, so a typo is a compile error rather than a 404 at publish time. */
export const XRPC = {
  createSession: '/xrpc/com.atproto.server.createSession',
  refreshSession: '/xrpc/com.atproto.server.refreshSession',
  deleteSession: '/xrpc/com.atproto.server.deleteSession',
  getSession: '/xrpc/com.atproto.server.getSession',
  createRecord: '/xrpc/com.atproto.repo.createRecord',
  deleteRecord: '/xrpc/com.atproto.repo.deleteRecord',
  uploadBlob: '/xrpc/com.atproto.repo.uploadBlob',
  resolveHandle: '/xrpc/com.atproto.identity.resolveHandle',
  getAuthorFeed: '/xrpc/app.bsky.feed.getAuthorFeed',
  getProfile: '/xrpc/app.bsky.actor.getProfile',
} as const;
