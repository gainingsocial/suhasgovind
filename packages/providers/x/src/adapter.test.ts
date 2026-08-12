import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import {
  parseRetryAfter,
  type ProviderAppCredentials,
  type ProviderCredentials,
  type ResolvedTargetContent,
  type TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createXAdapter, XError } from './adapter.js';

/** X is OAuth 2.0 with PKCE, so a registered platform application is mandatory. */
const app: ProviderAppCredentials = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/x/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2_pkce',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: '1234567890',
  grantedScopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
  metadata: { username: 'gainingsocial' },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '1234567890',
};

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

const gif = { ...image, mediaId: 'med_g', mimeType: 'image/gif' };
const video = {
  ...image,
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  durationSeconds: 30,
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the X adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createXAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(281) }),
});

describe('x validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createXAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  const codes = async (c: Partial<ResolvedTargetContent>) =>
    (await validate(c)).findings.map((f) => f.code);

  it('accepts text at the limit', async () => {
    const result = await validate({ text: 'x'.repeat(280) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('counts emoji as one character each', async () => {
    // "👋".length is 2 in UTF-16 but one character everywhere it matters. Counting UTF-16
    // units would reject valid posts made mostly of emoji.
    const result = await validate({ text: '👋'.repeat(280) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('accepts four images', async () => {
    const four = [0, 1, 2, 3].map((n) => ({ ...image, mediaId: `med_${n}` }));
    const result = await validate({ media: four });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('rejects a fifth image', async () => {
    const five = [0, 1, 2, 3, 4].map((n) => ({ ...image, mediaId: `med_${n}` }));
    expect(await codes({ media: five })).toContain('TOO_MANY_MEDIA_ITEMS');
  });

  it('refuses to mix video with images', async () => {
    expect(await codes({ media: [image, video] })).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('refuses to mix a GIF with images', async () => {
    // X allows four images, OR one video, OR one GIF — never a mixture.
    expect(await codes({ media: [image, gif] })).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('allows only one video', async () => {
    expect(await codes({ media: [video, { ...video, mediaId: 'med_v2' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('rejects a video longer than the limit', async () => {
    expect(await codes({ media: [{ ...video, durationSeconds: 141 }] })).toContain('VIDEO_TOO_LONG');
  });

  it('rejects an empty post', async () => {
    expect(await codes({ text: '   ', media: [] })).toContain('TEXT_REQUIRED');
  });

  it('rejects a poll posted alongside media', async () => {
    const result = await codes({
      media: [image],
      providerOptions: { poll: { options: ['a', 'b'], durationMinutes: 60 } },
    });
    expect(result).toContain('POLL_WITH_MEDIA_UNSUPPORTED');
  });

  it('rejects a poll with too few options', async () => {
    expect(await codes({ providerOptions: { poll: { options: ['only one'] } } })).toContain(
      'POLL_OPTION_COUNT_INVALID',
    );
  });

  it('rejects a poll duration outside the documented window', async () => {
    const result = await codes({
      providerOptions: { poll: { options: ['a', 'b'], durationMinutes: 4 } },
    });
    expect(result).toContain('POLL_DURATION_INVALID');
  });

  it('warns rather than fails when alt text is too long', async () => {
    // Alt text is truncated at upload; losing it entirely would be worse than losing the
    // post's tail of description.
    const result = await validate({ media: [{ ...image, altText: 'x'.repeat(1001) }] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('ALT_TEXT_TOO_LONG');
  });
});

describe('x authorization', () => {
  it('sends an S256 PKCE challenge and returns the verifier for the callback', async () => {
    const redirect = await createXAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-value',
      requestedScopes: [],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');

    // The engine encrypts and replays this at callback (plan §21.1). Without it the
    // exchange cannot succeed.
    expect(redirect.codeVerifier).toBeTypeOf('string');
    // RFC 7636 §4.1 allows 43-128 characters, and base64url carries no padding.
    expect(redirect.codeVerifier!.length).toBeGreaterThanOrEqual(43);
    expect(redirect.codeVerifier).not.toContain('=');

    const challenge = url.searchParams.get('code_challenge') ?? '';
    // A challenge equal to the verifier means S256 was declared but `plain` was sent.
    expect(challenge).not.toBe(redirect.codeVerifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('generates a different verifier every time', async () => {
    const adapter = createXAdapter();
    const make = () =>
      adapter.auth.createAuthorization({
        context: createTestContext(),
        app,
        state: 's',
        requestedScopes: [],
        options: {},
      });

    const [a, b] = await Promise.all([make(), make()]);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('refuses the callback when the code verifier was lost', async () => {
    await expect(
      createXAdapter().auth.exchangeCallback({
        context: createTestContext(),
        app,
        query: { code: 'auth-code' },
      }),
    ).rejects.toThrow(/code verifier/i);
  });

  it('requires a registered application rather than dereferencing null', async () => {
    await expect(
      createXAdapter().auth.createAuthorization({
        context: createTestContext(),
        app: null,
        state: 's',
        requestedScopes: [],
        options: {},
      }),
    ).rejects.toThrow(/No X application is configured/);
  });
});

describe('x capabilities', () => {
  const resolve = (grantedScopes: string[]) =>
    createXAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes,
    });

  it('withholds all publishing without the write scope', async () => {
    const effective = await resolve(['tweet.read', 'users.read']);
    expect(effective.publishing.text_only).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.text_only');
  });

  it('keeps text posting but withholds media without media.write', async () => {
    // media.write is granted separately from tweet.write, so an account can be able to
    // post text and unable to attach an image.
    const effective = await resolve(['tweet.read', 'tweet.write', 'users.read']);
    expect(effective.publishing.text_only).toBe(true);
    expect(effective.publishing.image).toBe(false);
    expect(effective.publishing.video).toBe(false);
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.image');
  });

  it('grants everything when every scope is present', async () => {
    const effective = await resolve([...credentials.grantedScopes]);
    expect(effective.publishing.image).toBe(true);
    expect(effective.restrictions).toHaveLength(0);
  });

  it('does not claim editing, which has no documented v2 endpoint', async () => {
    const generic = await createXAdapter().capabilities();
    expect(generic.actions.edit_post).toBe(false);
  });
});

describe('x reconciliation', () => {
  const reconcile = (overrides: Partial<ProviderCredentials> = {}, c = content()) =>
    createXAdapter().publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, ...overrides },
      target,
      content: c,
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

  it('reports indeterminate rather than guessing when the read scope is missing', async () => {
    // Failing closed is the point: X has no idempotency key, so retrying on uncertainty
    // is exactly how a duplicate post happens (ADR-006 Layer 4).
    const result = await reconcile({ grantedScopes: ['tweet.write'] });
    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('tweet.read');
  });

  it('reports indeterminate when the connection has no account id to search', async () => {
    const result = await reconcile({ externalAccountId: undefined });
    expect(result.conclusion).toBe('indeterminate');
  });
});

describe('x error normalization', () => {
  const normalize = (error: unknown) =>
    createXAdapter().normalizeError(error, { operation: 'publish', provider: 'x' });

  it('treats a duplicate-content refusal as needing reconciliation, not a retry', () => {
    // Retrying an identical post can only fail the same way, and POSSIBLE_DUPLICATE is
    // the code whose retry strategy is `reconcile_first`.
    const normalized = normalize(new XError(403, 'DuplicateContent', 'You have already said that.'));
    expect(normalized.code).toBe('POSSIBLE_DUPLICATE');
  });

  it('reports a media failure in prepare as retryable rather than ambiguous', () => {
    // Nothing was published when media processing failed, so there is no ambiguity for
    // the engine to reconcile — treating it as unknown would stall the target.
    const normalized = normalize(
      new XError(504, 'MEDIA_PROCESSING_TIMEOUT', 'X did not finish processing the media in time.'),
    );
    expect(normalized.code).toBe('MEDIA_PROCESSING_FAILED');
  });

  it('surfaces Retry-After from a rate limit', () => {
    const headers = new Headers({ 'retry-after': '30' });
    const normalized = normalize(
      new XError(429, undefined, 'Too Many Requests', parseRetryAfter(headers)),
    );
    expect(normalized.code).toBe('RATE_LIMITED');
    // Hammering a provider that told us when to come back is how a rate limit becomes a ban.
    expect(normalized.retryAfter).toBeTypeOf('string');
  });

  it('maps a missing refresh token to an auth failure a human can act on', () => {
    const normalized = normalize(
      new XError(401, 'NO_REFRESH_TOKEN', 'This X connection has no refresh token.'),
    );
    expect(normalized.code).toBe('AUTH_EXPIRED');
  });
});
