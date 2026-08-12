import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createTikTokAdapter, TikTokError } from './adapter.js';

/**
 * An audited application.
 *
 * The fixtures use one so the baseline suite exercises normal publishing; the unaudited
 * case — which plan §63 makes the interesting one — is asserted explicitly below.
 */
const app: ProviderAppCredentials = {
  clientId: 'test-client-key',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/tiktok/callback',
  metadata: { audited: true },
};

const unauditedApp: ProviderAppCredentials = { ...app, metadata: {} };

const credentials: ProviderCredentials = {
  strategy: 'oauth2_pkce',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: 'open_id_abc',
  grantedScopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'],
  metadata: { username: 'gainingsocial' },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'open_id_abc',
};

const video = {
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  bytes: 5_000_000,
  width: 1080,
  height: 1920,
  durationSeconds: 30,
  altText: null,
  downloadUrl: 'https://media.gainingsocial.com/med_v.mp4',
};

const photo = {
  mediaId: 'med_p',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 500_000,
  width: 1080,
  height: 1350,
  durationSeconds: null,
  altText: null,
  downloadUrl: 'https://media.gainingsocial.com/med_p.jpg',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the TikTok adapter.',
  media: [video],
  linkUrl: null,
  // TikTok rejects a post with no privacy level and offers no default, so valid content
  // always carries one.
  providerOptions: { privacyLevel: 'PUBLIC_TO_EVERYONE' },
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createTikTokAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(2201) }),
});

describe('tiktok validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>, withApp = app) =>
    createTikTokAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app: withApp,
    });

  const codes = async (c: Partial<ResolvedTargetContent>, withApp = app) =>
    (await validate(c, withApp)).findings.map((f) => f.code);

  it('rejects a text-only post, which TikTok has no concept of', async () => {
    expect(await codes({ media: [] })).toContain('MEDIA_REQUIRED');
  });

  it('requires an explicit privacy level', async () => {
    // TikTok's content-sharing guidelines make the creator choose, and the API rejects a
    // request without one. There is no default to fall back on.
    expect(await codes({ providerOptions: {} })).toContain('PRIVACY_LEVEL_REQUIRED');
  });

  it('rejects a privacy level TikTok does not define', async () => {
    expect(await codes({ providerOptions: { privacyLevel: 'FRIENDS' } })).toContain(
      'PRIVACY_LEVEL_INVALID',
    );
  });

  it('confines an unaudited client to private posting', async () => {
    // Plan §63. Publishing this would produce a post the creator believes is public and
    // nobody else can see.
    expect(await codes({}, unauditedApp)).toContain('PRIVACY_LEVEL_NOT_PERMITTED');
  });

  it('lets an unaudited client post privately', async () => {
    const result = await validate({ providerOptions: { privacyLevel: 'SELF_ONLY' } }, unauditedApp);
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('refuses to mix a video with photos', async () => {
    // Video and photo posts go to different endpoints entirely.
    expect(await codes({ media: [video, photo] })).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('allows only one video', async () => {
    expect(await codes({ media: [video, { ...video, mediaId: 'med_v2' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('accepts ten photos and rejects an eleventh', async () => {
    const ten = Array.from({ length: 10 }, (_, n) => ({ ...photo, mediaId: `med_p${n}` }));
    const ok = await validate({ media: ten });
    expect(ok.findings.filter((f) => f.severity === 'error')).toHaveLength(0);

    expect(await codes({ media: [...ten, { ...photo, mediaId: 'med_p10' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('rejects a PNG, which the photo endpoint does not accept', async () => {
    expect(await codes({ media: [{ ...photo, mimeType: 'image/png' }] })).toContain(
      'MEDIA_TYPE_UNSUPPORTED',
    );
  });

  it('rejects a video longer than the platform ceiling', async () => {
    expect(await codes({ media: [{ ...video, durationSeconds: 601 }] })).toContain('VIDEO_TOO_LONG');
  });

  it('refuses to post branded content privately', async () => {
    const result = await codes({
      providerOptions: { privacyLevel: 'SELF_ONLY' },
      compliance: { brandedContent: true },
    });
    expect(result).toContain('BRANDED_CONTENT_CANNOT_BE_PRIVATE');
  });
});

describe('tiktok capabilities', () => {
  it('narrows an unaudited client to private posting and says why', async () => {
    const effective = await createTikTokAdapter().capabilities({
      context: createTestContext(),
      app: unauditedApp,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: [...credentials.grantedScopes],
    });

    expect(effective.constraints.allowed_privacy_levels).toEqual(['SELF_ONLY']);
    const restriction = effective.restrictions.find(
      (r) => r.capability === 'constraints.allowed_privacy_levels',
    );
    // An agent must be able to tell "TikTok can't" from "we're waiting on an audit".
    expect(restriction?.reason).toBe('provider_approval_pending');
    expect(restriction?.agent_action).toBe('await_platform_approval');
  });

  it('offers every privacy level once the audit is recorded', async () => {
    const effective = await createTikTokAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: [...credentials.grantedScopes],
    });

    expect(effective.constraints.allowed_privacy_levels).toContain('PUBLIC_TO_EVERYONE');
    expect(effective.restrictions).toHaveLength(0);
  });

  it('withholds publishing without the publish scope', async () => {
    const effective = await createTikTokAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: ['user.info.basic'],
    });

    expect(effective.publishing.video).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.video');
  });

  it('never claims text-only posting', async () => {
    const generic = await createTikTokAdapter().capabilities();
    expect(generic.publishing.text_only).toBe(false);
  });
});

describe('tiktok authorization', () => {
  it('sends client_key rather than client_id, with an S256 challenge', async () => {
    const redirect = await createTikTokAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-value',
      requestedScopes: [],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    // TikTok is the one provider that renames this parameter. Sending `client_id`
    // produces an error about an unregistered application.
    expect(url.searchParams.get('client_key')).toBe('test-client-key');
    expect(url.searchParams.get('client_id')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirect.codeVerifier).toBeTypeOf('string');
    expect(url.searchParams.get('code_challenge')).not.toBe(redirect.codeVerifier);
  });

  it('comma-separates scopes, as TikTok expects', async () => {
    const redirect = await createTikTokAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 's',
      requestedScopes: ['user.info.basic', 'video.publish'],
      options: {},
    });

    expect(new URL(redirect.authorizationUrl).searchParams.get('scope')).toBe(
      'user.info.basic,video.publish',
    );
  });
});

describe('tiktok reconciliation', () => {
  it('reports indeterminate without the Display API scope rather than guessing', async () => {
    // TikTok creates nothing before `init`, so there is no container to interrogate. The
    // video list is the only way to look, and it needs a scope from a different product.
    const result = await createTikTokAdapter().publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, grantedScopes: ['video.publish'] },
      target,
      content: content(),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('video.list');
  });
});

describe('tiktok error normalization', () => {
  const normalize = (error: unknown) =>
    createTikTokAdapter().normalizeError(error, { operation: 'publish', provider: 'tiktok' });

  it('treats a spam-risk refusal as a rate limit, not a retryable failure', () => {
    // Retrying immediately deepens the penalty; backing off is the only thing that helps.
    const normalized = normalize(
      new TikTokError(200, 'spam_risk_too_many_pending_share', 'Too many pending shares.'),
    );
    expect(normalized.code).toBe('RATE_LIMITED');
  });

  it('explains an unverified media host as a configuration fault', () => {
    const normalized = normalize(
      new TikTokError(400, 'url_ownership_unverified', 'URL ownership is unverified.'),
    );
    expect(normalized.code).toBe('VALIDATION_FAILED');
    expect(normalized.message).toContain('developer portal');
  });

  it('maps an unavailable privacy level to the privacy error the taxonomy defines', () => {
    const normalized = normalize(
      new TikTokError(400, 'privacy_level_not_available', 'That privacy level is unavailable.'),
    );
    expect(normalized.code).toBe('PRIVACY_SELECTION_REQUIRED');
  });

  it('does not treat a 200 with an error body as success', () => {
    // TikTok returns HTTP 200 with a populated `error` object for most rejections.
    // Trusting the status alone would report a rejected post as published.
    const normalized = normalize(new TikTokError(200, 'invalid_param', 'Bad parameter.'));
    expect(normalized.code).toBe('VALIDATION_FAILED');
  });
});
