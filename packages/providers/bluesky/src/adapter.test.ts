import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type { ProviderCredentials, ResolvedTargetContent, TargetRef } from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createBlueskyAdapter } from './adapter.js';
import { MAX_TEXT_GRAPHEMES } from './constants.js';
import { countGraphemes, countUtf8Bytes, detectFacets, truncateGraphemes } from './richtext.js';

const credentials: ProviderCredentials = {
  strategy: 'app_password',
  secret: 'abcd-efgh-ijkl-mnop',
  externalAccountId: 'did:plc:test',
  grantedScopes: [],
  metadata: { handle: 'tester.bsky.social', did: 'did:plc:test' },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'did:plc:test',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Bluesky adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

// The shared contract suite every adapter must pass (plan §65, §66.2).
certifyAdapter({
  createAdapter: createBlueskyAdapter,
  credentials,
  // `app_password` needs no registered platform app — the reason Bluesky ships first.
  app: null,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(MAX_TEXT_GRAPHEMES + 1) }),
});

/**
 * Text measurement.
 *
 * Bluesky enforces 300 *graphemes* and 3000 *bytes*, and JavaScript's `String.length` is
 * neither. These are the cases where the naive implementation is wrong in a way that
 * silently rejects valid posts.
 */
describe('bluesky text measurement', () => {
  it('counts a family emoji as one character, not eleven', () => {
    const family = '👨‍👩‍👧‍👦';
    // The trap: String.length reports 11 for this, so a length-based check would reject a
    // post at roughly a third of the real limit.
    expect(family.length).toBeGreaterThan(1);
    expect(countGraphemes(family)).toBe(1);
  });

  it('counts a flag emoji as one character', () => {
    expect(countGraphemes('🇮🇳')).toBe(1);
  });

  it('accepts exactly 300 emoji on graphemes but rejects them on bytes', async () => {
    // The reason both limits are checked. 300 four-byte emoji is 1200 bytes and passes,
    // but a heavier grapheme cluster does not — and only the byte check catches it.
    const heavy = '👨‍👩‍👧‍👦'.repeat(300);
    expect(countGraphemes(heavy)).toBe(300);
    expect(countUtf8Bytes(heavy)).toBeGreaterThan(3000);

    const result = await createBlueskyAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content({ text: heavy }),
      credentials,
      app: null,
    });

    const errors = result.findings.filter((f) => f.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('bytes');
  });

  it('truncates without splitting a grapheme', () => {
    const text = 'a👨‍👩‍👧‍👦b';
    const truncated = truncateGraphemes(text, 2);
    expect(countGraphemes(truncated)).toBe(2);
    // A naive slice would leave a lone surrogate, which is invalid UTF-8.
    expect(truncated).toBe('a👨‍👩‍👧‍👦');
  });
});

/**
 * Facet byte offsets.
 *
 * Facets index into the UTF-8 encoding, not the JavaScript string. Any non-ASCII character
 * before a link shifts the two apart, and the result is a highlight on the wrong
 * characters or a rejected record.
 */
describe('bluesky facets', () => {
  it('uses byte offsets, not string indices, when the text contains non-ASCII', () => {
    const text = 'héllo https://example.com';
    const { facets } = detectFacets(text);

    expect(facets).toHaveLength(1);
    // 'héllo ' is 6 UTF-16 units but 7 UTF-8 bytes, because é is two bytes.
    expect(text.indexOf('https')).toBe(6);
    expect(facets[0]?.index.byteStart).toBe(7);
  });

  it('places the offset correctly after an emoji', () => {
    const text = '🎉 https://example.com';
    const { facets } = detectFacets(text);
    // The party popper is 4 bytes, plus the space.
    expect(facets[0]?.index.byteStart).toBe(5);
  });

  it('spans exactly the URL', () => {
    const text = 'see https://example.com/a/b now';
    const { facets } = detectFacets(text);
    const { byteStart, byteEnd } = facets[0]!.index;

    const bytes = new TextEncoder().encode(text);
    const spanned = new TextDecoder().decode(bytes.slice(byteStart, byteEnd));
    expect(spanned).toBe('https://example.com/a/b');
  });

  it('does not swallow trailing sentence punctuation', () => {
    const { facets } = detectFacets('read https://example.com.');
    const feature = facets[0]?.features[0] as unknown as { uri: string };
    expect(feature.uri).toBe('https://example.com');
  });

  it('detects mentions separately, since they need a DID lookup', () => {
    const { facets, mentions } = detectFacets('hi @alice.bsky.social');
    // Not a facet yet — resolving the handle is a network call the validator must not make.
    expect(facets).toHaveLength(0);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.handle).toBe('alice.bsky.social');
  });

  it('ignores an email address rather than treating it as a mention', () => {
    const { mentions } = detectFacets('write to me@example.com please');
    expect(mentions).toHaveLength(0);
  });

  it('detects hashtags without the leading hash in the stored tag', () => {
    const { facets } = detectFacets('shipping #buildinpublic today');
    const feature = facets[0]?.features[0] as unknown as { $type: string; tag: string };
    expect(feature.$type).toContain('#tag');
    expect(feature.tag).toBe('buildinpublic');
  });
});

describe('bluesky validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createBlueskyAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app: null,
    });

  it('rejects a fifth image', async () => {
    const image = {
      mediaId: 'med_1',
      kind: 'image' as const,
      mimeType: 'image/jpeg',
      bytes: 1000,
      width: 100,
      height: 100,
      durationSeconds: null,
      altText: 'x',
      downloadUrl: 'https://example.com/x.jpg',
    };

    const result = await validate({ media: Array.from({ length: 5 }, () => image) });
    const codes = result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toContain('TOO_MANY_MEDIA_ITEMS');
  });

  it('rejects video, which this adapter does not publish', async () => {
    const result = await validate({
      media: [
        {
          mediaId: 'med_v',
          kind: 'video',
          mimeType: 'video/mp4',
          bytes: 1000,
          width: 100,
          height: 100,
          durationSeconds: 10,
          altText: null,
          downloadUrl: 'https://example.com/v.mp4',
        },
      ],
    });

    const codes = result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toContain('MEDIA_TYPE_UNSUPPORTED');
  });

  it('warns about missing alt text without blocking the post', async () => {
    const result = await validate({
      media: [
        {
          mediaId: 'med_1',
          kind: 'image',
          mimeType: 'image/png',
          bytes: 1000,
          width: 10,
          height: 10,
          durationSeconds: null,
          altText: null,
          downloadUrl: 'https://example.com/x.png',
        },
      ],
    });

    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('MEDIA_ALT_TEXT_MISSING');
  });

  it('rejects an empty post', async () => {
    const result = await validate({ text: '   ', media: [] });
    const codes = result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
    expect(codes).toContain('TEXT_REQUIRED');
  });

  it('warns that images displace a link preview', async () => {
    const result = await validate({
      linkUrl: 'https://example.com',
      media: [
        {
          mediaId: 'med_1',
          kind: 'image',
          mimeType: 'image/png',
          bytes: 1000,
          width: 10,
          height: 10,
          durationSeconds: null,
          altText: 'x',
          downloadUrl: 'https://example.com/x.png',
        },
      ],
    });

    expect(result.estimatedTransformations.map((t) => t.kind)).toContain('link_shortened');
  });
});

describe('bluesky capabilities', () => {
  it('declares images but not video', async () => {
    const capabilities = await createBlueskyAdapter().capabilities();
    expect(capabilities.publishing.image).toBe(true);
    expect(capabilities.publishing.carousel).toBe(true);
    // Claiming video before the adapter implements it would make preflight approve posts
    // that then fail (Rule 2).
    expect(capabilities.publishing.video).toBe(false);
  });

  it('reports the documented limits', async () => {
    const capabilities = await createBlueskyAdapter().capabilities();
    expect(capabilities.constraints.max_text_length).toBe(300);
    expect(capabilities.constraints.max_media_count).toBe(4);
    expect(capabilities.constraints.max_image_bytes).toBe(2_000_000);
  });
});
