import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type { ProviderCredentials, ResolvedTargetContent, TargetRef } from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createTelegramAdapter } from './adapter.js';

const credentials: ProviderCredentials = {
  strategy: 'bot_token',
  secret: '123456:ABC-DEF',
  externalAccountId: '123456',
  grantedScopes: [],
  metadata: { username: 'testbot', chats: [{ id: '-1001', title: 'Test channel' }] },
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '-1001',
};

const image = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/jpeg',
  bytes: 1000,
  width: 100,
  height: 100,
  durationSeconds: null,
  altText: null,
  downloadUrl: 'https://example.com/x.jpg',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Telegram adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createTelegramAdapter,
  credentials,
  app: null,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(4097) }),
  // The Bot API offers no way to search a chat for the bot's own past messages, so an
  // ambiguous outcome genuinely cannot be resolved automatically. Documented rather than
  // silently omitted, which is what the harness demands.
  reconciliationUnavailableBecause:
    'The Telegram Bot API provides no method to search a chat for the bot’s own earlier messages, so a lost confirmation cannot be verified. Such a post is escalated to a human rather than retried.',
});

describe('telegram validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createTelegramAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app: null,
    });

  it('allows 4096 characters in a plain message', async () => {
    const result = await validate({ text: 'x'.repeat(4096) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('drops to 1024 characters once an image is attached', async () => {
    // The trap: the caption limit is a quarter of the message limit. Text that is fine
    // on its own becomes invalid the moment a photo is added.
    const text = 'x'.repeat(2000);
    expect((await validate({ text })).findings.filter((f) => f.severity === 'error')).toHaveLength(0);

    const withImage = await validate({ text, media: [image] });
    const errors = withImage.findings.filter((f) => f.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('1024');
  });

  it('rejects an eleventh album item', async () => {
    const result = await validate({ media: Array.from({ length: 11 }, () => image) });
    expect(result.findings.map((f) => f.code)).toContain('TOO_MANY_MEDIA_ITEMS');
  });

  it('warns that alt text will be dropped rather than silently discarding it', async () => {
    const result = await validate({ media: [{ ...image, altText: 'a description' }] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('MEDIA_ALT_TEXT_UNSUPPORTED');
  });

  it('rejects an empty message', async () => {
    const result = await validate({ text: '  ', media: [] });
    expect(result.findings.map((f) => f.code)).toContain('TEXT_REQUIRED');
  });
});

describe('telegram capabilities', () => {
  it('reports the documented limits', async () => {
    const capabilities = await createTelegramAdapter().capabilities();
    expect(capabilities.constraints.max_text_length).toBe(4096);
    expect(capabilities.constraints.max_media_count).toBe(10);
    // The Bot API has no alt-text field on photos.
    expect(capabilities.constraints.supports_alt_text).toBe(false);
  });
});
