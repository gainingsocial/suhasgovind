import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import { describe, expect, it } from 'vitest';

import { createInstagramAdapter } from './adapter.js';

const app: ProviderAppCredentials = {
  clientId: '1234567890',
  clientSecret: 'test-app-secret',
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/instagram/callback',
  metadata: {},
};

const credentials: ProviderCredentials = {
  strategy: 'oauth2',
  accessToken: 'test-page-token',
  externalAccountId: '17841400000000000',
  grantedScopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
  metadata: { pageId: '111222333' },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '17841400000000000',
};

const jpeg = {
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

const png = { ...jpeg, mediaId: 'med_png', mimeType: 'image/png' };
const reel = {
  ...jpeg,
  mediaId: 'med_v',
  kind: 'video' as const,
  mimeType: 'video/mp4',
  durationSeconds: 30,
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Instagram adapter.',
  media: [jpeg],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createInstagramAdapter,
  credentials,
  app,
  target,
  validContent: content(),
  // A text-only post: the one thing Instagram genuinely cannot do.
  invalidContent: content({ media: [] }),
});

describe('instagram validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createInstagramAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app,
    });

  it('rejects a text-only post', async () => {
    // Instagram has no text-only post at all. Catching it in preflight means a fan-out
    // that includes Instagram alongside Bluesky and LinkedIn fails with a clear reason
    // rather than succeeding on two networks and failing on the third.
    const result = await validate({ media: [] });
    expect(result.findings.map((f) => f.code)).toContain('MEDIA_REQUIRED');
  });

  it('rejects PNG, because Instagram accepts JPEG only', async () => {
    // Not "JPEG preferred" — documented as the only supported image format. Instagram's
    // own error names the format without saying it is unsupported everywhere.
    const result = await validate({ media: [png] });
    expect(result.findings.map((f) => f.code)).toContain('MEDIA_TYPE_UNSUPPORTED');
  });

  it('enforces the 30-hashtag ceiling', async () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    const result = await validate({ text: tags });
    expect(result.findings.map((f) => f.code)).toContain('TOO_MANY_HASHTAGS');
  });

  it('counts hashtags with emoji and accents correctly', async () => {
    // Counted with Unicode property escapes rather than \w, which would split a hashtag
    // at the first accented character and report twice as many as there are.
    const result = await validate({ text: '#café #niño #日本語' });
    expect(result.findings.map((f) => f.code)).not.toContain('TOO_MANY_HASHTAGS');
  });

  it('caps a carousel at 10 items', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...jpeg, mediaId: `med_${i}` }));
    const result = await validate({ media: many });
    expect(result.findings.map((f) => f.code)).toContain('TOO_MANY_MEDIA_ITEMS');
  });

  it('rejects a video shorter than the Reels minimum', async () => {
    const result = await validate({ media: [{ ...reel, durationSeconds: 1 }] });
    expect(result.findings.map((f) => f.code)).toContain('VIDEO_TOO_SHORT');
  });

  it('warns that a caption URL will not be clickable', async () => {
    // A warning, not an error: the post publishes, the link just is not a link. Blocking
    // it would be wrong; saying nothing would let a campaign ship a dead call to action.
    const result = await validate({ linkUrl: 'https://gainingsocial.com' });
    const finding = result.findings.find((f) => f.code === 'LINK_NOT_CLICKABLE');
    expect(finding?.severity).toBe('warning');
  });
});

describe('instagram capabilities', () => {
  it('declares no text-only publishing at all', async () => {
    // Generic capability, with no connection involved. This is a platform fact, not a
    // permission problem, so it must not appear as a restriction that re-authorizing fixes.
    const generic = await createInstagramAdapter().capabilities();
    expect(generic.publishing.text_only).toBe(false);
  });

  it('declares no delete, because the API has none', async () => {
    // Declaring it would put a Delete button in the dashboard that silently does nothing.
    const generic = await createInstagramAdapter().capabilities();
    expect(generic.actions.delete_post).toBe(false);
    expect(createInstagramAdapter().publishing.delete).toBeUndefined();
  });

  it('explains a personal account as an account-type problem, not a scope problem', async () => {
    // A personal account can complete the entire OAuth flow and then publish nothing. The
    // remedy is to convert the account, which re-authorizing will never accomplish.
    const effective = await createInstagramAdapter().capabilities({
      context: createTestContext(),
      app,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: [...credentials.grantedScopes],
      accountType: 'PERSONAL',
    });

    expect(effective.publishing.image).toBe(false);
    const restriction = effective.restrictions.find((r) => r.capability === 'publishing.image');
    expect(restriction?.reason).toBe('account_type_ineligible');
  });
});
