import { certifyAdapter, createTestContext } from '@gs/provider-kit/certification';
import type { ProviderCredentials, ResolvedTargetContent, TargetRef } from '@gs/provider-kit';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMockAdapter } from './adapter.js';
import { mockStore } from './store.js';

const credentials: ProviderCredentials = {
  strategy: 'api_key',
  secret: 'mock-api-key',
  externalAccountId: 'mock_account_1',
  grantedScopes: ['post.write', 'post.read', 'destination.read'],
  metadata: {},
};

const target: TargetRef = {
  postId: 'pst_test',
  postTargetId: 'ptg_test',
  destinationExternalId: 'mock_dst_primary',
};

const content = (overrides: Partial<ResolvedTargetContent> = {}): ResolvedTargetContent => ({
  text: 'Hello from the reference adapter.',
  media: [],
  linkUrl: null,
  providerOptions: {},
  compliance: {},
  ...overrides,
});

beforeEach(() => {
  mockStore.reset();
});

// The shared contract suite every adapter must pass (plan §65, §66.2).
certifyAdapter({
  createAdapter: createMockAdapter,
  credentials,
  app: null,
  target,
  validContent: content(),
  invalidContent: content({ text: 'x'.repeat(501) }),
});

/**
 * Behaviours specific to the mock, which exist to prove the *engine* can be tested.
 * If these do not work, none of the effective-once tests in the publisher mean anything.
 */
describe('mock provider simulation', () => {
  it('publishes and returns a native post id and url', async () => {
    const result = await createMockAdapter().publishing.publish({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      content: content(),
      prepared: { state: {}, providerMediaIds: [] },
      idempotencyKey: 'fingerprint-1',
    });

    expect(result.outcome).toBe('published');
    expect(result.externalPostId).toMatch(/^mock_post_/);
    expect(result.externalUrl).toContain(result.externalPostId);
  });

  it('records the post before an ambiguous timeout, so reconciliation can find it', async () => {
    // The scenario that makes duplicate posts happen in real products (plan §2.2): the
    // side effect landed, the response did not.
    const adapter = createMockAdapter();
    mockStore.setBehaviour({ failWith: 'timeout_after_side_effect', remaining: 1 });

    await expect(
      adapter.publishing.publish({
        context: createTestContext(),
        app: null,
        credentials,
        target,
        content: content(),
        prepared: { state: {}, providerMediaIds: [] },
        idempotencyKey: 'fingerprint-orphan',
      }),
    ).rejects.toThrow();

    const reconciled = await adapter.publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      content: content(),
      idempotencyKey: 'fingerprint-orphan',
      attemptedAfter: new Date(Date.now() - 60_000).toISOString(),
    });

    // Must be `found`. Anything else and the engine would republish, duplicating.
    expect(reconciled.conclusion).toBe('found');
    expect(reconciled.externalPostId).toMatch(/^mock_post_/);
  });

  it('proves absence when the timeout had no side effect, so a retry is safe', async () => {
    const adapter = createMockAdapter();
    mockStore.setBehaviour({ failWith: 'timeout_no_side_effect', remaining: 1 });

    await expect(
      adapter.publishing.publish({
        context: createTestContext(),
        app: null,
        credentials,
        target,
        content: content(),
        prepared: { state: {}, providerMediaIds: [] },
        idempotencyKey: 'fingerprint-absent',
      }),
    ).rejects.toThrow();

    const reconciled = await adapter.publishing.findPossibleDuplicate!({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      content: content(),
      idempotencyKey: 'fingerprint-absent',
      attemptedAfter: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(reconciled.conclusion).toBe('absent');
  });

  it('surfaces Retry-After on a rate limit so backoff can honour it', async () => {
    const adapter = createMockAdapter();
    mockStore.setBehaviour({ failWith: 'rate_limited', remaining: 1, retryAfterSeconds: 5 });

    const error = await adapter.publishing
      .publish({
        context: createTestContext(),
        app: null,
        credentials,
        target,
        content: content(),
        prepared: { state: {}, providerMediaIds: [] },
        idempotencyKey: 'fingerprint-429',
      })
      .catch((e: unknown) => e);

    const normalized = adapter.normalizeError(error, { operation: 'publish', provider: 'mock' });
    expect(normalized.code).toBe('RATE_LIMITED');
    expect(normalized.retryAfter).toBeDefined();
    expect(Date.parse(normalized.retryAfter!)).toBeGreaterThan(Date.now());
  });

  it('recovers after the configured number of failures', async () => {
    const adapter = createMockAdapter();
    mockStore.setBehaviour({ failWith: 'unavailable', remaining: 2 });

    const attempt = () =>
      adapter.publishing.publish({
        context: createTestContext(),
        app: null,
        credentials,
        target,
        content: content(),
        prepared: { state: {}, providerMediaIds: [] },
        idempotencyKey: 'fingerprint-retry',
      });

    await expect(attempt()).rejects.toThrow();
    await expect(attempt()).rejects.toThrow();
    // Third attempt succeeds — the shape almost every retry test needs.
    await expect(attempt()).resolves.toMatchObject({ outcome: 'published' });
  });

  it('reports processing then published for an async provider', async () => {
    const adapter = createMockAdapter();
    mockStore.setBehaviour({ failWith: 'processing', remaining: 1, processingMs: 0 });

    const published = await adapter.publishing.publish({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      content: content(),
      prepared: { state: {}, providerMediaIds: [] },
      idempotencyKey: 'fingerprint-async',
    });

    expect(published.outcome).toBe('processing');
    expect(published.statusHandle).toBeDefined();

    const status = await adapter.publishing.status!({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      statusHandle: published.statusHandle!,
    });

    expect(status.outcome).toBe('published');
    expect(status.externalUrl).toContain(published.externalPostId);
  });

  it('treats a repeated delete as success, not an error', async () => {
    const adapter = createMockAdapter();
    const published = await adapter.publishing.publish({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      content: content(),
      prepared: { state: {}, providerMediaIds: [] },
      idempotencyKey: 'fingerprint-delete',
    });

    const first = await adapter.publishing.delete!({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      externalPostId: published.externalPostId,
    });
    const second = await adapter.publishing.delete!({
      context: createTestContext(),
      app: null,
      credentials,
      target,
      externalPostId: published.externalPostId,
    });

    expect(first.alreadyAbsent).toBe(false);
    // P4: running the same operation twice must be safe.
    expect(second.alreadyAbsent).toBe(true);
  });

  it('narrows effective capability and explains why', async () => {
    const adapter = createMockAdapter();
    const effective = await adapter.capabilities({
      context: createTestContext(),
      app: null,
      credentials,
      destinationExternalId: target.destinationExternalId,
      grantedScopes: ['post.read'],
    });

    expect(effective.publishing.image).toBe(false);
    const reasons = effective.restrictions.map((r) => r.capability);
    expect(reasons).toContain('publishing.image');
    expect(effective.restrictions[0]?.reason).toBe('scope_missing');
  });
});
