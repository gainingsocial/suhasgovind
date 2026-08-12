import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createPinterestAdapter, PinterestError } from './adapter.js';

const app: ProviderAppCredentials = {
  clientId: 'test-app-id',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/pinterest/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: 'gainingsocial',
  grantedScopes: ['user_accounts:read', 'boards:read', 'pins:read', 'pins:write'],
  metadata: { username: 'gainingsocial' },
};

/** The destination is a board, not the account — a Pin without one has nowhere to go. */
const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '1234567890123456789',
};

const image = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 500_000,
  width: 1000,
  height: 1500,
  durationSeconds: null,
  altText: 'A tree',
  downloadUrl: 'https://media.gainingsocial.com/med_1.jpg',
};

const video = {
  ...image,
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  bytes: 10_000_000,
  durationSeconds: 30,
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Pinterest adapter.',
  media: [image],
  linkUrl: 'https://gainingsocial.com',
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createPinterestAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(801) }),
});

describe('pinterest validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createPinterestAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  const codes = async (c: Partial<ResolvedTargetContent>) =>
    (await validate(c)).findings.map((f) => f.code);

  it('rejects a text-only Pin, which Pinterest has no concept of', async () => {
    expect(await codes({ media: [] })).toContain('MEDIA_REQUIRED');
  });

  it('refuses to mix a video with images', async () => {
    expect(await codes({ media: [image, video] })).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('allows only one video', async () => {
    expect(await codes({ media: [video, { ...video, mediaId: 'med_v2' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('accepts five carousel images and rejects a sixth', async () => {
    const five = Array.from({ length: 5 }, (_, n) => ({ ...image, mediaId: `med_${n}` }));
    const ok = await validate({ media: five });
    expect(ok.findings.filter((f) => f.severity === 'error')).toHaveLength(0);

    expect(await codes({ media: [...five, { ...image, mediaId: 'med_5' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('rejects a carousel with only one image', async () => {
    // Silently downgrading a one-image carousel to a standard Pin would publish something
    // other than what was asked for.
    expect(await codes({ media: [image], providerOptions: { carousel: true } })).toContain(
      'CAROUSEL_TOO_SHORT',
    );
  });

  it('rejects a video shorter than Pinterest accepts', async () => {
    expect(await codes({ media: [{ ...video, durationSeconds: 2 }] })).toContain('VIDEO_TOO_SHORT');
  });

  it('rejects a video longer than Pinterest accepts', async () => {
    expect(await codes({ media: [{ ...video, durationSeconds: 901 }] })).toContain('VIDEO_TOO_LONG');
  });

  it('rejects an unsupported image type', async () => {
    expect(await codes({ media: [{ ...image, mimeType: 'image/webp' }] })).toContain(
      'MEDIA_TYPE_UNSUPPORTED',
    );
  });

  it('rejects a Pin with neither title nor description', async () => {
    expect(await codes({ text: '   ', providerOptions: { title: '  ' } })).toContain('TEXT_REQUIRED');
  });

  it('warns rather than fails when the title is too long', async () => {
    // The title is truncated at publish; losing the Pin over it would be worse.
    const result = await validate({ providerOptions: { title: 'x'.repeat(101) } });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('TITLE_TOO_LONG');
  });

  it('warns rather than fails when alt text is too long', async () => {
    const result = await validate({ media: [{ ...image, altText: 'x'.repeat(501) }] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('ALT_TEXT_TOO_LONG');
  });
});

describe('pinterest capabilities', () => {
  const resolve = (grantedScopes: string[]) =>
    createPinterestAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes,
    });

  it('withholds publishing without the write scope', async () => {
    const effective = await resolve(['boards:read', 'pins:read']);
    expect(effective.publishing.image).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.image');
  });

  it('grants everything when every scope is present', async () => {
    const effective = await resolve([...credentials.grantedScopes]);
    expect(effective.publishing.image).toBe(true);
    expect(effective.publishing.carousel).toBe(true);
    expect(effective.restrictions).toHaveLength(0);
  });

  it('never claims text-only posting', async () => {
    const generic = await createPinterestAdapter().capabilities();
    expect(generic.publishing.text_only).toBe(false);
  });
});

describe('pinterest authorization', () => {
  it('comma-separates scopes and round-trips the state', async () => {
    const redirect = await createPinterestAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-value',
      requestedScopes: ['boards:read', 'pins:write'],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.pinterest.com/oauth/');
    expect(url.searchParams.get('scope')).toBe('boards:read,pins:write');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('requires a registered application rather than dereferencing null', async () => {
    await expect(
      createPinterestAdapter().auth.createAuthorization({
        context: createTestContext(),
        app: null,
        state: 's',
        requestedScopes: [],
        options: {},
      }),
    ).rejects.toThrow(/No Pinterest application is configured/);
  });
});

describe('pinterest reconciliation', () => {
  it('reports indeterminate rather than guessing when no read scope was granted', async () => {
    // Pinterest offers no idempotency key, so retrying on uncertainty creates a second Pin.
    const result = await createPinterestAdapter().publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, grantedScopes: ['pins:write'] },
      target,
      content: content(),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('pins:read');
  });
});

describe('pinterest error normalization', () => {
  const normalize = (error: unknown) =>
    createPinterestAdapter().normalizeError(error, { operation: 'publish', provider: 'pinterest' });

  it('maps Pinterest rate-limit code 29 to RATE_LIMITED', () => {
    expect(normalize(new PinterestError(429, '29', 'Too many requests.')).code).toBe('RATE_LIMITED');
  });

  it('treats an upload failure in prepare as retryable rather than ambiguous', () => {
    // Nothing was pinned yet, so there is no ambiguity for the engine to reconcile.
    expect(normalize(new PinterestError(500, 'UPLOAD_FAILED', 'Upload failed.')).code).toBe(
      'MEDIA_PROCESSING_FAILED',
    );
  });

  it('does not guess at an unrecognized failure', () => {
    expect(normalize(new Error('never seen')).code).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});
