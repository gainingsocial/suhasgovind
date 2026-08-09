import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createLinkedInAdapter } from './adapter.js';

/** LinkedIn is OAuth, so a registered platform application is mandatory. */
const app: ProviderAppCredentials = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/linkedin/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  externalAccountId: 'abc123',
  grantedScopes: ['w_member_social', 'w_organization_social', 'r_organization_social'],
  metadata: { authorUrn: 'urn:li:person:abc123' },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'urn:li:person:abc123',
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

const video = { ...image, mediaId: 'med_v', kind: 'video' as const, mimeType: 'video/mp4' };

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the LinkedIn adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createLinkedInAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(3001) }),
});

describe('linkedin validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createLinkedInAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  it('accepts commentary at the limit', async () => {
    const result = await validate({ text: 'x'.repeat(3000) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('refuses to mix video and images in one post', async () => {
    // The Posts API takes a single content.media, so a post is images OR a video.
    // Discovering that at publish time would waste an upload.
    const result = await validate({ media: [image, video] });
    expect(result.findings.map((f) => f.code)).toContain('MEDIA_MIXED_TYPES_UNSUPPORTED');
  });

  it('allows only one video', async () => {
    const result = await validate({ media: [video, { ...video, mediaId: 'med_v2' }] });
    expect(result.findings.map((f) => f.code)).toContain('TOO_MANY_MEDIA_ITEMS');
  });

  it('rejects an empty post', async () => {
    const result = await validate({ text: '   ', media: [] });
    expect(result.findings.map((f) => f.code)).toContain('TEXT_REQUIRED');
  });
});

describe('linkedin capabilities', () => {
  it('withholds publishing when neither write scope was granted', async () => {
    const effective = await createLinkedInAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      // A read-only grant. LinkedIn's two write scopes are separate from reading.
      grantedScopes: ['r_organization_social'],
    });

    expect(effective.publishing.text_only).toBe(false);
    // Every removal must explain itself, or an agent cannot tell "impossible" from
    // "re-authorize to fix".
    expect(effective.restrictions.map((r) => r.capability)).toContain('publishing.text_only');
    expect(effective.restrictions[0]?.reason).toBe('scope_missing');
  });

  it('keeps publishing when only the member write scope is present', async () => {
    const effective = await createLinkedInAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: ['w_member_social'],
    });

    // Either write scope is enough — requiring both would wrongly disable posting for a
    // member who never connected a company page.
    expect(effective.publishing.text_only).toBe(true);
  });

  it('pins the API version rather than tracking latest', async () => {
    // LinkedIn sunsets versions on a schedule. Sending "latest" would break silently on
    // whichever release changes a field.
    expect(createLinkedInAdapter().providerApiVersion).toMatch(/^\d{6}$/);
  });
});

describe('linkedin reconciliation', () => {
  it('reports indeterminate rather than guessing when the read scope is missing', async () => {
    const adapter = createLinkedInAdapter();
    const result = await adapter.publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app,
      credentials: { ...credentials, grantedScopes: ['w_member_social'] },
      target,
      content: content(),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    // Failing closed is the point: retrying on uncertainty is how a duplicate happens.
    expect(result.conclusion).toBe('indeterminate');
    expect(result.reason).toContain('r_member_social');
  });
});
