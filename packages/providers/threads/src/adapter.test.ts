import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import { describe, expect, it } from 'vitest';

import { createThreadsAdapter } from './adapter.js';

const app: ProviderAppCredentials = {
  clientId: '9876543210',
  clientSecret: 'test-threads-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/threads/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-threads-token',
  externalAccountId: '7654321',
  grantedScopes: ['threads_basic', 'threads_content_publish', 'threads_read_replies', 'threads_manage_replies'],
  metadata: {},
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '7654321',
};

const image = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 1000,
  width: 1080,
  height: 1080,
  durationSeconds: null,
  altText: 'A test image',
  downloadUrl: 'https://example.com/x.jpg',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Threads adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createThreadsAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(501) }),
});

describe('threads validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createThreadsAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  it('accepts text at exactly 500 characters', async () => {
    const result = await validate({ text: 'x'.repeat(500) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('counts an appended link against the 500-character limit', async () => {
    // Threads has no separate link field, so the URL lands in the body. Checking the text
    // alone would approve a post that Threads then rejects for length — and the caller
    // would see a limit they appear not to have exceeded.
    const url = `https://gainingsocial.com/${'a'.repeat(60)}`;
    const result = await validate({ text: 'x'.repeat(470), linkUrl: url });

    expect(result.findings.map((f) => f.code)).toContain('TEXT_TOO_LONG');
  });

  it('does not double-count a URL already present in the text', async () => {
    const url = 'https://gainingsocial.com';
    const result = await validate({ text: `Read more at ${url}`, linkUrl: url });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('counts emoji as one character each', async () => {
    // "👋".length is 2 in UTF-16 but one character to every platform. Counting by code
    // units rejects valid posts, and posts contain emoji constantly.
    const result = await validate({ text: '👋'.repeat(500) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('allows text-only posts, unlike Instagram', async () => {
    const result = await validate({ text: 'Just text.', media: [] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('allows a 20-item carousel', async () => {
    // Twice Instagram's ceiling. Sharing a limit between the two would silently reject
    // half of what Threads accepts.
    const many = Array.from({ length: 20 }, (_, i) => ({ ...image, mediaId: `med_${i}` }));
    const result = await validate({ media: many });
    expect(result.findings.map((f) => f.code)).not.toContain('TOO_MANY_MEDIA_ITEMS');
  });
});

describe('threads configuration', () => {
  it('authorizes on threads.net rather than facebook.com', async () => {
    // Threads is a separate app registration on a separate host. Sending a user to the
    // Facebook consent screen would ask for permissions that do not exist there.
    const redirect = await createThreadsAdapter().auth.createAuthorization({
      context: createTestContext(),
      app,
      state: 'state-token',
      requestedScopes: [],
      options: {},
    });

    const url = new URL(redirect.authorizationUrl);
    expect(url.hostname).toBe('threads.net');
    expect(url.searchParams.get('scope')).toContain('threads_content_publish');
    // The state must survive untouched — it is the CSRF defence for the whole flow.
    expect(url.searchParams.get('state')).toBe('state-token');
  });

  it('names the separate app registration when none is configured', async () => {
    // Rule 14. The likely cause is a Facebook app pasted into the Threads slot, so the
    // error says so rather than just reporting a missing configuration.
    await expect(
      createThreadsAdapter().auth.createAuthorization({
        context: createTestContext(),
        app: null,
        state: 'state-token',
        requestedScopes: [],
        options: {},
      }),
    ).rejects.toThrow(/own app registration/);
  });
});
