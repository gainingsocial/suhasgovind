import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createGoogleBusinessProfileAdapter, GoogleBusinessError } from './adapter.js';

const SCOPE_MANAGE = 'https://www.googleapis.com/auth/business.manage';

const app: ProviderAppCredentials = {
  clientId: 'test-client.apps.googleusercontent.com',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/google-business-profile/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: 'accounts/111111111111',
  grantedScopes: [SCOPE_MANAGE],
  metadata: {},
};

/**
 * The destination id is the whole v4 resource path: publishing needs
 * `accounts/{account}/locations/{location}`, and a bare location id cannot be reassembled.
 */
const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'accounts/111111111111/locations/222222222222',
};

const photo = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 500_000,
  width: 800,
  height: 600,
  durationSeconds: null,
  altText: null,
  downloadUrl: 'https://media.gainingsocial.com/med_1.jpg',
};

const video = {
  ...photo,
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  durationSeconds: 20,
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Open late this week — come and say hello.',
  media: [photo],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createGoogleBusinessProfileAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(1501) }),
});

describe('google business profile validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createGoogleBusinessProfileAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  const codes = async (c: Partial<ResolvedTargetContent>) =>
    (await validate(c)).findings.map((f) => f.code);

  it('accepts a text-only post', async () => {
    const result = await validate({ media: [] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('rejects an empty post', async () => {
    expect(await codes({ text: '  ', media: [] })).toContain('TEXT_REQUIRED');
  });

  it('rejects a video, which local posts do not take', async () => {
    // Google documents only PHOTO for local posts; accepting video would approve a post
    // the API rejects.
    expect(await codes({ media: [video] })).toContain('MEDIA_TYPE_UNSUPPORTED');
  });

  it('allows only one photo', async () => {
    expect(await codes({ media: [photo, { ...photo, mediaId: 'med_2' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('rejects a photo smaller than 250 pixels on an edge', async () => {
    expect(await codes({ media: [{ ...photo, width: 200, height: 600 }] })).toContain(
      'MEDIA_DIMENSIONS_TOO_SMALL',
    );
  });

  it('rejects an unknown topic type', async () => {
    expect(await codes({ providerOptions: { topicType: 'NEWSLETTER' } })).toContain('TOPIC_TYPE_INVALID');
  });

  it('requires event details on an EVENT post', async () => {
    // The fields are not optional the way the resource shape suggests.
    const result = await codes({ providerOptions: { topicType: 'EVENT' } });
    expect(result).toContain('EVENT_TITLE_REQUIRED');
    expect(result).toContain('EVENT_SCHEDULE_REQUIRED');
  });

  it('accepts an EVENT post that carries a title and a schedule', async () => {
    const result = await validate({
      providerOptions: {
        topicType: 'EVENT',
        event: { title: 'Late night opening', schedule: { startDate: { year: 2026, month: 9, day: 1 } } },
      },
    });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('rejects an unknown call-to-action type', async () => {
    expect(await codes({ providerOptions: { callToAction: { actionType: 'DANCE' } } })).toContain(
      'CALL_TO_ACTION_INVALID',
    );
  });

  it('requires a URL for every call to action except CALL', async () => {
    expect(await codes({ providerOptions: { callToAction: { actionType: 'ORDER' } } })).toContain(
      'CALL_TO_ACTION_URL_REQUIRED',
    );
  });

  it('does not demand a URL for a CALL button, which uses the listed phone number', async () => {
    const result = await validate({ providerOptions: { callToAction: { actionType: 'CALL' } } });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('accepts a call to action whose URL comes from the post link', async () => {
    const result = await validate({
      linkUrl: 'https://gainingsocial.com',
      providerOptions: { callToAction: { actionType: 'LEARN_MORE' } },
    });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });
});

describe('google business profile capabilities', () => {
  it('withholds everything without the single scope that exists', async () => {
    const effective = await createGoogleBusinessProfileAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: [],
    });

    expect(effective.publishing.text_only).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.text_only');
  });

  it('never claims video, which local posts do not support', async () => {
    const generic = await createGoogleBusinessProfileAdapter().capabilities();
    expect(generic.publishing.video).toBe(false);
    expect(generic.publishing.native_scheduling).toBe(true);
  });
});

describe('google business profile authorization', () => {
  it('asks for offline access and forces consent', async () => {
    const redirect = await createGoogleBusinessProfileAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-value',
      requestedScopes: [],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(SCOPE_MANAGE);
  });
});

describe('google business profile reconciliation', () => {
  it('reports indeterminate rather than guessing without the scope', async () => {
    const result = await createGoogleBusinessProfileAdapter().publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, grantedScopes: [] },
      target,
      content: content(),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('business.manage');
  });
});

describe('google business profile error normalization', () => {
  const normalize = (error: unknown) =>
    createGoogleBusinessProfileAdapter().normalizeError(error, {
      operation: 'publish',
      provider: 'google_business_profile',
    });

  it('explains that PERMISSION_DENIED is usually unapproved project access', () => {
    // Google grants Business Profile API access per project by application; until that is
    // approved every call fails this way, and no scope change helps.
    const normalized = normalize(
      new GoogleBusinessError(403, 'PERMISSION_DENIED', 'The caller does not have permission.'),
    );
    expect(normalized.code).toBe('AUTH_SCOPE_MISSING');
    expect(normalized.message).toContain('per project by application');
  });

  it('maps an account with no Business Profile to an eligibility failure', () => {
    expect(normalize(new GoogleBusinessError(403, 'NO_ACCOUNT', 'No profile.')).code).toBe(
      'ACCOUNT_NOT_ELIGIBLE',
    );
  });

  it('treats an exhausted project quota as a quota failure', () => {
    expect(normalize(new GoogleBusinessError(429, 'RESOURCE_EXHAUSTED', 'Quota gone.')).code).toBe(
      'DAILY_QUOTA_EXCEEDED',
    );
  });

  it('does not guess at an unrecognized failure', () => {
    expect(normalize(new Error('never seen')).code).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});
