import { GraphError } from '@gs/provider-meta-core';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import { describe, expect, it } from 'vitest';

import { createFacebookAdapter } from './adapter.js';

const app: ProviderAppCredentials = {
  clientId: '1234567890',
  clientSecret: 'test-app-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/facebook/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-page-token',
  externalAccountId: '111222333',
  grantedScopes: [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'pages_manage_engagement',
    'publish_video',
  ],
  metadata: {},
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '111222333',
};

const image = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 1000,
  width: 100,
  height: 100,
  durationSeconds: null,
  altText: 'A test image',
  downloadUrl: 'https://example.com/x.jpg',
};

const video = { ...image, mediaId: 'med_v', kind: 'video' as const, mimeType: 'video/mp4' };

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Facebook adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createFacebookAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ media: [video, { ...video, mediaId: 'med_v2' }] }),
});

describe('facebook validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createFacebookAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  it('accepts a link-only post', async () => {
    // Unlike Instagram, a Facebook post can be a bare link with no media.
    const result = await validate({ text: '', linkUrl: 'https://gainingsocial.com' });
    expect(result.findings.filter((finding) => finding.severity === 'error')).toHaveLength(0);
  });

  it('rejects an empty post', async () => {
    const result = await validate({ text: '   ', media: [], linkUrl: null });
    expect(result.findings.map((finding) => finding.code)).toContain('TEXT_REQUIRED');
  });

  it('refuses to mix video and images in one post', async () => {
    // /videos and /photos are different endpoints producing different post types.
    const result = await validate({ media: [image, video] });
    expect(result.findings.map((finding) => finding.code)).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('warns rather than fails when a link accompanies media', async () => {
    // Facebook shows the photo and drops the link card, but the post still publishes —
    // an error here would block something the customer may well have intended.
    const result = await validate({ media: [image], linkUrl: 'https://gainingsocial.com' });
    const finding = result.findings.find((f) => f.code === 'LINK_PREVIEW_SUPPRESSED');
    expect(finding?.severity).toBe('warning');
  });
});

describe('facebook capabilities', () => {
  it('separates video from the other publishing permissions', async () => {
    // publish_video is a distinct permission, and a Page connection often has the posting
    // permissions without it. Reporting video as available would approve a post that
    // fails only because it happens to carry a video.
    const effective = await createFacebookAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: ['pages_manage_posts', 'pages_read_engagement'],
    });

    expect(effective.publishing.text_only).toBe(true);
    expect(effective.publishing.image).toBe(true);
    expect(effective.publishing.video).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.video');
  });

  it('withholds all publishing without pages_manage_posts', async () => {
    const effective = await createFacebookAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: ['pages_show_list', 'pages_read_engagement'],
    });

    expect(effective.publishing.text_only).toBe(false);
    expect(effective.restrictions[0]?.reason).toBe('scope_missing');
  });
});

describe('facebook error mapping', () => {
  const normalize = (error: unknown) =>
    createFacebookAdapter().normalizeError(error, { operation: 'publish', provider: 'facebook' });

  it('routes a duplicate-post rejection to reconciliation, not to failure', async () => {
    // The single most important mapping in this adapter. Facebook refuses content
    // identical to something recently posted. On a *retry* after an ambiguous timeout,
    // that refusal is near-proof the first attempt actually landed.
    //
    // Calling it CONTENT_REJECTED marks a live post as failed. Retrying duplicates it.
    // POSSIBLE_DUPLICATE asks Facebook what exists before doing either.
    const normalized = normalize(
      new GraphError(400, { code: 506, message: 'Duplicate status message' }, ''),
    );

    expect(normalized.code).toBe('POSSIBLE_DUPLICATE');
  });

  it('distinguishes an expired token from a revoked one', async () => {
    // A plain 190 can be fixed by re-exchanging the token. The listed subcodes mean the
    // user did something a refresh cannot undo, so the customer must reconnect.
    expect(normalize(new GraphError(401, { code: 190, message: 'expired' }, '')).code).toBe('AUTH_EXPIRED');
    expect(
      normalize(new GraphError(401, { code: 190, error_subcode: 460, message: 'password changed' }, '')).code,
    ).toBe('AUTH_REVOKED');
  });

  it('reads subcode 33 as a missing destination rather than a bad parameter', async () => {
    // Meta's "object does not exist or you cannot see it". Almost always a Page that was
    // disconnected, and "invalid parameter" sends the reader looking in the wrong place.
    const normalized = normalize(
      new GraphError(400, { code: 100, error_subcode: 33, message: 'Unsupported get request.' }, ''),
    );
    expect(normalized.code).toBe('DESTINATION_NOT_FOUND');
  });

  it('treats a policy block as rate limiting, not as rejected content', async () => {
    // The same content publishes fine once the block lifts, so blaming the content would
    // send the customer editing a post that was never the problem.
    expect(normalize(new GraphError(403, { code: 368, message: 'temporarily blocked' }, '')).code).toBe(
      'RATE_LIMITED',
    );
  });

  it('does not guess at an unrecognized failure', async () => {
    // Rule 14 — UNKNOWN_PROVIDER_ERROR is deliberately not auto-retried.
    expect(normalize(new Error('something new')).code).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});
