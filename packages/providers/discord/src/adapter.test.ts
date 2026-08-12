import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type {
  ProviderCredentials,
  ResolvedTargetContent,
  TargetRef,
} from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { createDiscordAdapter, DiscordError } from './adapter.js';

/** A bot token needs no registered platform application, so `app` is null throughout. */
const credentials: ProviderCredentials = {
  strategy: 'bot_token',
  secret: 'test-bot-token',
  externalAccountId: '900000000000000001',
  grantedScopes: [],
  metadata: { username: 'gainingsocial' },
};

/** The destination is a channel, not the bot. */
const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: '800000000000000002',
};

const image = {
  mediaId: 'med_1',
  kind: 'image' as const,
  mimeType: 'image/png',
  bytes: 500_000,
  width: 800,
  height: 600,
  durationSeconds: null,
  altText: 'A chart',
  downloadUrl: 'https://media.gainingsocial.com/med_1.png',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the Discord adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

certifyAdapter({
  createAdapter: createDiscordAdapter,
  credentials,
  app: null,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(2001) }),
});

describe('discord validation', () => {
  const validate = (c: Partial<ResolvedTargetContent>) =>
    createDiscordAdapter().publishing.validate({
      context: createTestContext(),
      target,
      content: content(c),
      credentials,
      app: null,
    });

  const codes = async (c: Partial<ResolvedTargetContent>) =>
    (await validate(c)).findings.map((f) => f.code);

  it('accepts content at the 2000-character limit', async () => {
    const result = await validate({ text: 'x'.repeat(2000) });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('rejects an empty message', async () => {
    expect(await codes({ text: '   ', media: [] })).toContain('TEXT_REQUIRED');
  });

  it('accepts ten attachments and rejects an eleventh', async () => {
    const ten = Array.from({ length: 10 }, (_, n) => ({ ...image, mediaId: `med_${n}` }));
    const ok = await validate({ media: ten });
    expect(ok.findings.filter((f) => f.severity === 'error')).toHaveLength(0);

    expect(await codes({ media: [...ten, { ...image, mediaId: 'med_10' }] })).toContain(
      'TOO_MANY_MEDIA_ITEMS',
    );
  });

  it('rejects an attachment over the unboosted upload limit', async () => {
    expect(await codes({ media: [{ ...image, bytes: 11 * 1024 * 1024 }] })).toContain('MEDIA_TOO_LARGE');
  });

  it('accepts a file type Discord has no inline renderer for', async () => {
    // Discord accepts any file type; only size is a hard constraint. Rejecting an unusual
    // MIME type here would refuse posts Discord would happily take.
    const result = await validate({ media: [{ ...image, mimeType: 'application/pdf' }] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('warns rather than fails when an attachment description is too long', async () => {
    const result = await validate({ media: [{ ...image, altText: 'x'.repeat(1025) }] });
    expect(result.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    expect(result.findings.map((f) => f.code)).toContain('ALT_TEXT_TOO_LONG');
  });
});

describe('discord capabilities', () => {
  it('does not pretend to know per-channel permissions in advance', async () => {
    // A bot token carries no scopes, and Discord only reveals channel permission by
    // rejecting the send. Inventing a restriction here would be a guess.
    const effective = await createDiscordAdapter().capabilities({
      context: createTestContext(),
      app: null,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: [],
    });

    expect(effective.resolution).toBe('effective');
    expect(effective.publishing.text_only).toBe(true);
    expect(effective.restrictions).toHaveLength(0);
  });
});

describe('discord error normalization', () => {
  const normalize = (error: unknown) =>
    createDiscordAdapter().normalizeError(error, { operation: 'publish', provider: 'discord' });

  it('names the missing permission rather than reporting a bare 403', () => {
    // A bot removed from a server and a bot missing one channel permission are both 403,
    // and the fix differs completely.
    const normalized = normalize(new DiscordError(403, 50013, 'Missing Permissions'));
    expect(normalized.code).toBe('AUTH_SCOPE_MISSING');
    expect(normalized.message).toContain('Send Messages');
  });

  it('distinguishes being removed from a server from a channel permission', () => {
    const normalized = normalize(new DiscordError(403, 50001, 'Missing Access'));
    expect(normalized.message).toContain('removed from this server');
  });

  it('honours the JSON retry_after, which is more precise than the header', () => {
    // Discord escalates to a temporary ban for repeat offenders, so retrying early is
    // materially worse than waiting.
    const normalized = normalize(
      new DiscordError(429, undefined, 'You are being rate limited.', {
        retryAfter: new Date(Date.now() + 1500).toISOString(),
        global: true,
      }),
    );
    expect(normalized.code).toBe('RATE_LIMITED');
    expect(normalized.retryAfter).toBeTypeOf('string');
    expect(normalized.message).toContain('global limit');
  });

  it('maps an unknown channel to a destination failure', () => {
    expect(normalize(new DiscordError(404, 10003, 'Unknown Channel')).code).toBe(
      'DESTINATION_NOT_FOUND',
    );
  });

  it('does not guess at an unrecognized failure', () => {
    expect(normalize(new Error('never seen')).code).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});

describe('discord reconciliation', () => {
  it('cannot identify an attachment-only message, and answers without a request', async () => {
    // Matching on timing alone is the reasoning that duplicates posts. The verdict is
    // reached before any call, so an unanswerable question costs nothing.
    const context = createTestContext();
    const result = await createDiscordAdapter().publishing.findPossibleDuplicate!({
      context,
      app: null,
      credentials,
      target,
      content: content({ text: '', media: [image] }),
      idempotencyKey: 'fingerprint',
      attemptedAfter: new Date().toISOString(),
      providerMediaIds: [],
    });

    expect(result.conclusion).toBe('indeterminate');
    expect(context.entries).toHaveLength(0);
  });
});
