import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createYouTubeAdapter, YouTubeError } from './adapter.js';

const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const SCOPE_MANAGE = 'https://www.googleapis.com/auth/youtube';

/** An audited Google Cloud project; the unaudited case is asserted explicitly below. */
const app: ProviderAppCredentials = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/youtube/callback',
  metadata: { audited: true },
};

const unauditedApp: ProviderAppCredentials = { ...app, metadata: {} };

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: 'UC_channel_id',
  grantedScopes: [SCOPE_UPLOAD, SCOPE_MANAGE],
  metadata: {},
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'UC_channel_id',
};

const video = {
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  bytes: 50_000_000,
  width: 1920,
  height: 1080,
  durationSeconds: 120,
  altText: null,
  downloadUrl: 'https://media.gainingsocial.com/med_v.mp4',
};

const image = {
  ...video,
  mediaId: 'med_i',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  durationSeconds: null,
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the YouTube adapter.',
  media: [video],
  linkUrl: null,
  providerOptions: { title: 'A test upload', privacyStatus: 'public' },
  // YouTube requires a COPPA audience declaration on every upload; there is no default.
  compliance: { madeForKids: false },
  ...overrides,
});

certifyAdapter({
  createAdapter: createYouTubeAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(5001) }),
});

describe('youtube validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>, withApp = app) =>
    createYouTubeAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app: withApp,
    });

  const codes = async (c: Partial<ResolvedTargetContent>, withApp = app) =>
    (await validate(c, withApp)).findings.map((f) => f.code);

  it('rejects a post with no video', async () => {
    expect(await codes({ media: [] })).toContain('MEDIA_REQUIRED');
  });

  it('rejects images, which YouTube does not publish', async () => {
    expect(await codes({ media: [image] })).toContain('MEDIA_TYPE_UNSUPPORTED');
  });

  it('allows only one video per upload', async () => {
    expect(await codes({ media: [video, { ...video, mediaId: 'med_v2' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('requires an explicit made-for-kids declaration', async () => {
    // A legal declaration under COPPA. Guessing it is not an option.
    expect(await codes({ compliance: {} })).toContain('AUDIENCE_DECLARATION_REQUIRED');
  });

  it('rejects angle brackets in a description, which YouTube will not accept', async () => {
    expect(await codes({ text: 'Watch <this> now' })).toContain('DESCRIPTION_CHARACTERS_INVALID');
  });

  it('warns that angle brackets are stripped from a title rather than failing', async () => {
    const result = await validate({ providerOptions: { title: 'A <great> video', privacyStatus: 'public' } });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('TITLE_CHARACTERS_REMOVED');
  });

  it('rejects tags totalling more than 500 characters', async () => {
    const tags = Array.from({ length: 20 }, () => 'x'.repeat(30));
    expect(await codes({ providerOptions: { title: 't', privacyStatus: 'public', tags } })).toContain(
      'TAGS_TOO_LONG',
    );
  });

  it('rejects a video longer than the unverified-account ceiling', async () => {
    expect(await codes({ media: [{ ...video, durationSeconds: 901 }] })).toContain('VIDEO_TOO_LONG');
  });

  it('refuses a public upload from an unaudited project', async () => {
    // Google would accept this and publish it privately anyway, so the caller would
    // believe a public video exists that nobody can watch (plan §63).
    expect(await codes({}, unauditedApp)).toContain('PRIVACY_LEVEL_NOT_PERMITTED');
  });

  it('lets an unaudited project upload privately', async () => {
    const result = await validate(
      { providerOptions: { title: 't', privacyStatus: 'private' } },
      unauditedApp,
    );
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });
});

describe('youtube capabilities', () => {
  const resolve = (grantedScopes: string[], withApp = app) =>
    createYouTubeAdapter().capabilities({
      context: createTestContext(),
      app: withApp,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes,
    });

  it('narrows an unverified project to private uploads and says why', async () => {
    const effective = await resolve([SCOPE_UPLOAD, SCOPE_MANAGE], unauditedApp);
    expect(effective.constraints.allowed_privacy_levels).toEqual(['private']);
    const restriction = effective.restrictions.find(
      (r) => r.capability === 'constraints.allowed_privacy_levels',
    );
    expect(restriction?.reason).toBe('provider_approval_pending');
  });

  it('lets an upload-only grant publish but not delete', async () => {
    // youtube.upload is deliberately narrower than youtube; conflating them would offer
    // a delete endpoint that always fails.
    const effective = await resolve([SCOPE_UPLOAD]);
    expect(effective.publishing.video).toBe(true);
    expect(effective.actions.delete_post).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('actions.delete_post');
  });

  it('withholds publishing when neither upload scope was granted', async () => {
    const effective = await resolve(['https://www.googleapis.com/auth/youtube.readonly']);
    expect(effective.publishing.video).toBe(false);
  });

  it('claims provider-side scheduling, which publishAt genuinely provides', async () => {
    const generic = await createYouTubeAdapter().capabilities();
    expect(generic.publishing.native_scheduling).toBe(true);
  });
});

describe('youtube authorization', () => {
  it('asks for offline access and forces consent, or the refresh token never arrives', async () => {
    const redirect = await createYouTubeAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-value',
      requestedScopes: [],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    // Without both of these Google returns an access token that expires in an hour and
    // nothing to renew it with.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-value');
  });
});

describe('youtube reconciliation', () => {
  it('reports indeterminate when only the upload scope was granted', async () => {
    // The upload-only scope cannot read the channel, so there is no way to look.
    const result = await createYouTubeAdapter().publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, grantedScopes: [SCOPE_UPLOAD] },
      target,
      content: content(),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('upload-only');
  });
});

describe('youtube error normalization', () => {
  const normalize = (error: unknown) =>
    createYouTubeAdapter().normalizeError(error, { operation: 'publish', provider: 'youtube' });

  it('treats an exhausted quota as a quota failure, not a rate limit', () => {
    // videos.insert costs 1,600 of a 10,000-unit daily allowance, so this is routine.
    // Retrying before the window resets can only fail.
    expect(normalize(new YouTubeError(403, 'quotaExceeded', 'Quota exceeded.')).code).toBe(
      'DAILY_QUOTA_EXCEEDED',
    );
  });

  it('separates a per-second rate limit from the daily quota', () => {
    expect(normalize(new YouTubeError(403, 'rateLimitExceeded', 'Slow down.')).code).toBe('RATE_LIMITED');
  });

  it('maps a missing channel to a destination failure a human can act on', () => {
    expect(normalize(new YouTubeError(403, 'channelNotFound', 'No channel.')).code).toBe(
      'DESTINATION_NOT_FOUND',
    );
  });

  it('does not guess at an unrecognized failure', () => {
    // Re-uploading a video that may already exist costs 1,600 quota units and duplicates
    // the post on the channel.
    expect(normalize(new Error('never seen')).code).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});
