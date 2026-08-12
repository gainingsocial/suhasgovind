import { newUuidV7 } from '@gs/contracts/ids';
import { CredentialCipher, Keyring } from '@gs/crypto';
import {
  createDatabaseHandle,
  createPostWithTargets,
  getPostWithTargets,
  listPostAttempts,
  providerFlagKey,
  schema,
  setSimulationMode,
  storeCredential,
  upsertFeatureFlag,
  type Database,
  type DatabaseHandle,
} from '@gs/db';
import { createTenantHarness, databaseUrl, type TenantHarness } from '@gs/db/test-support';
import { createLogger, newTraceContext } from '@gs/observability';
import { mockStore } from '@gs/provider-mock';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Env } from './env.js';
import { executeTarget } from './execute-target.js';
import { reconcileTarget } from './reconcile.js';

/**
 * Publisher integration tests.
 *
 * These cover the Phase-1 required tests that live below the API: duplicate queue
 * delivery causes one provider side effect, a 429 is delayed rather than hammered, a
 * permanent 4xx is not retried, and an ambiguous timeout becomes reconciliation rather
 * than a blind retry.
 *
 * They run against a real database and the mock adapter. The database is not optional
 * here — the entire guarantee rests on a conditional UPDATE, and an in-memory fake would
 * not have one.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

/**
 * 32 bytes of base64, which is what the keyring requires.
 *
 * Built with Web-standard `btoa` rather than Node's `Buffer`: every package here compiles
 * against the Workers runtime types only, and reaching for a Node built-in — even in a
 * test — would mean loosening that for the whole package.
 */
const TEST_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describeIntegration('publisher: executeTarget', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;
  let env: Env;

  const logger = createLogger(newTraceContext(), { service: 'test', level: 'error' });

  beforeAll(async () => {
    h = await createTenantHarness(['posts:write']);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;

    env = {
      ENVIRONMENT: 'test',
      SERVICE_VERSION: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: h.connectionString,
      CREDENTIAL_KEK_V1: TEST_KEK,
      CREDENTIAL_KEK_ACTIVE_VERSION: '1',
    };

    // The mock adapter's `api_key` strategy reads `secret`, so one credential is enough.
    const cipher = new CredentialCipher(
      Keyring.fromEnv({ CREDENTIAL_KEK_V1: TEST_KEK, CREDENTIAL_KEK_ACTIVE_VERSION: '1' }),
    );
    const encrypted = await cipher.encrypt('mock-api-key', {
      organizationId: h.tenantA.organizationId,
      projectId: h.tenantA.projectId,
      connectionId: h.tenantA.connectionId,
      credentialType: 'api_key',
    });

    await storeCredential(db, {
      connectionId: h.tenantA.connectionId,
      organizationId: h.tenantA.organizationId,
      projectId: h.tenantA.projectId,
      credentialType: 'api_key',
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      algorithm: encrypted.algorithm,
      keyVersion: encrypted.keyVersion,
    });
  });

  afterEach(() => {
    mockStore.reset();
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  /** A queued post with one target against the seeded mock destination. */
  async function seedQueuedPost(fingerprint = newUuidV7()) {
    const created = await createPostWithTargets(db, {
      profileId: h.tenantA.profileId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      projectId: h.tenantA.projectId,
      organizationId: h.tenantA.organizationId,
      content: { text: 'Publish me', media_ids: [] },
      status: 'queued',
      targets: [
        {
          destinationId: h.tenantA.destinationId,
          connectionId: h.tenantA.connectionId,
          provider: 'mock',
          contentFingerprint: fingerprint,
          status: 'queued',
        },
      ],
    });

    return { postId: created.post.id, targetId: created.targets[0]!.id };
  }

  const message = (postId: string, targetId: string) =>
    ({ type: 'publish.target', postId, postTargetId: targetId, traceId: 'trc_test' }) as const;

  it('publishes a queued target and records the provider post id', async () => {
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('published');

    const after = await getPostWithTargets(db, postId);
    expect(after?.post.status).toBe('published');
    expect(after?.targets[0]?.status).toBe('published');
    expect(after?.targets[0]?.providerPostId).toMatch(/^mock_post_/);
    expect(after?.targets[0]?.providerPostUrl).toContain('mock.invalid');
  });

  it('causes ONE provider side effect when the same message is delivered twice', async () => {
    // The Phase-1 required test. Cloudflare Queues are at-least-once, so this happens in
    // production; the lease is what makes it safe.
    const { postId, targetId } = await seedQueuedPost();

    const first = await executeTarget(db, env, message(postId, targetId), logger);
    const second = await executeTarget(db, env, message(postId, targetId), logger);

    expect(first.outcome).toBe('published');
    // The second delivery must not publish. It loses the lease because the target is no
    // longer in a leasable status.
    expect(second.outcome).toBe('skipped');
    expect(second.reason).toBe('lease_not_acquired');

    // And the mock recorded exactly one post.
    expect(mockStore.all()).toHaveLength(1);
  });

  it('causes ONE provider side effect when two deliveries race', async () => {
    const { postId, targetId } = await seedQueuedPost();

    const [a, b] = await Promise.all([
      executeTarget(db, env, message(postId, targetId), logger),
      executeTarget(db, env, message(postId, targetId), logger),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['published', 'skipped']);
    expect(mockStore.all()).toHaveLength(1);
  });

  it('delays a 429 rather than hammering the provider', async () => {
    mockStore.setBehaviour({ failWith: 'rate_limited', remaining: 1, retryAfterSeconds: 60 });
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('retryable_failed');
    expect(result.reason).toBe('RATE_LIMITED');

    const after = await getPostWithTargets(db, postId);
    const target = after!.targets[0]!;
    expect(target.status).toBe('retryable_failed');

    // The provider's own Retry-After is honoured, not a schedule we invented.
    const delayMs = target.nextAttemptAt!.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(50_000);
    expect(delayMs).toBeLessThan(70_000);
  });

  it('does not retry a permanent 4xx', async () => {
    mockStore.setBehaviour({ failWith: 'content_rejected', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('permanent_failed');

    const after = await getPostWithTargets(db, postId);
    expect(after?.targets[0]?.status).toBe('permanent_failed');
    // No retry scheduled — the same content would be rejected the same way.
    expect(after?.targets[0]?.nextAttemptAt).toBeNull();
    expect(after?.post.status).toBe('failed');
  });

  it('marks an expired token as blocked rather than retrying forever', async () => {
    mockStore.setBehaviour({ failWith: 'auth_expired', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    // Blocked on the connection: retrying cannot help until a human re-authorizes.
    expect(result.outcome).toBe('permanent_failed');
    expect(result.reason).toBe('AUTH_EXPIRED');
  });

  it('turns an ambiguous timeout into reconciliation, not a retry', async () => {
    // The scenario that produces duplicate posts in real products: the post IS created
    // and the response never arrives.
    mockStore.setBehaviour({ failWith: 'timeout_after_side_effect', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('reconciliation_required');

    const after = await getPostWithTargets(db, postId);
    expect(after?.targets[0]?.status).toBe('unknown_reconciliation_required');
    // Crucially: no retry was scheduled. A blind retry here duplicates the post.
    expect(after?.targets[0]?.nextAttemptAt).toBeNull();
    // The provider does have the post.
    expect(mockStore.all()).toHaveLength(1);
  });

  it('adopts the orphaned post during reconciliation instead of republishing', async () => {
    mockStore.setBehaviour({ failWith: 'timeout_after_side_effect', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    await executeTarget(db, env, message(postId, targetId), logger);

    const outcome = await reconcileTarget(
      db,
      env,
      { type: 'publish.reconcile', postId, postTargetId: targetId, traceId: 'trc_test' },
      logger,
    );

    expect(outcome).toBe('found');

    const after = await getPostWithTargets(db, postId);
    expect(after?.targets[0]?.status).toBe('published');
    expect(after?.targets[0]?.providerPostId).toBe(mockStore.all()[0]?.externalPostId);
    // Still exactly one post at the provider. This is the whole point.
    expect(mockStore.all()).toHaveLength(1);
  });

  it('retries after reconciliation proves nothing was published', async () => {
    mockStore.setBehaviour({ failWith: 'timeout_no_side_effect', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    await executeTarget(db, env, message(postId, targetId), logger);
    expect(mockStore.all()).toHaveLength(0);

    const outcome = await reconcileTarget(
      db,
      env,
      { type: 'publish.reconcile', postId, postTargetId: targetId, traceId: 'trc_test' },
      logger,
    );

    // Provably absent, so retrying cannot duplicate anything.
    expect(outcome).toBe('absent');

    const after = await getPostWithTargets(db, postId);
    expect(after?.targets[0]?.status).toBe('retryable_failed');
  });

  it('handles async provider processing without claiming published', async () => {
    mockStore.setBehaviour({ failWith: 'processing', remaining: 1, processingMs: 0 });
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('processing');

    const after = await getPostWithTargets(db, postId);
    // Not `published` — the post is not live yet, and saying otherwise is a lie the
    // customer can see by clicking the link.
    expect(after?.targets[0]?.status).toBe('provider_processing');
  });

  it('writes an attempt record even when the provider call fails', async () => {
    // Rule 6 — the attempt is opened before the call, so a failure still leaves evidence.
    mockStore.setBehaviour({ failWith: 'unavailable', remaining: 1 });
    const { postId, targetId } = await seedQueuedPost();

    await executeTarget(db, env, message(postId, targetId), logger);

    const attempts = await db
      .select()
      .from(schema.postTargetAttempts)
      .where(eq(schema.postTargetAttempts.postTargetId, targetId));

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('retryable_failed');
    expect(attempts[0]?.errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(attempts[0]?.finishedAt).not.toBeNull();
  });

  it('stops retrying once the attempt budget is exhausted', async () => {
    // maxAttempts defaults to 5. Without this guard a permanently broken target would be
    // retried forever.
    mockStore.setBehaviour({ failWith: 'unavailable', remaining: 100 });
    const { postId, targetId } = await seedQueuedPost();

    const outcomes: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      // Clear the backoff so the lease is eligible again immediately.
      await db
        .update(schema.postTargets)
        .set({ nextAttemptAt: null })
        .where(eq(schema.postTargets.id, targetId));

      outcomes.push((await executeTarget(db, env, message(postId, targetId), logger)).outcome);
    }

    expect(outcomes.filter((o) => o === 'retryable_failed')).toHaveLength(5);
    // Once the budget is gone the lease refuses, so no further provider calls happen.
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
  });

  it('runs the whole pipeline and contacts no provider when simulating', async () => {
    // Plan §49. The valuable property is that the *state machine is identical* — a test
    // mode that ends in a different status would force every customer to write a branch
    // in order to test themselves.
    const { postId, targetId } = await seedQueuedPost();
    await setSimulationMode(db, h.tenantA.projectEnvironmentId, true);

    try {
      const result = await executeTarget(db, env, message(postId, targetId), logger);
      expect(result).toMatchObject({ outcome: 'published', reason: 'simulated' });

      const after = await getPostWithTargets(db, postId);
      expect(after?.post.status).toBe('published');
      expect(after?.targets[0]?.status).toBe('published');

      // What differs: no provider was touched, the id is synthetic, and there is no URL
      // for a reader to follow to a post that does not exist.
      expect(mockStore.all()).toHaveLength(0);
      expect(after?.targets[0]?.providerPostId).toMatch(/^sim_ptg_/);
      expect(after?.targets[0]?.providerPostUrl).toBeNull();
      expect(after?.targets[0]?.simulated).toBe(true);
    } finally {
      await setSimulationMode(db, h.tenantA.projectEnvironmentId, false);
    }
  });

  it('records a simulated attempt as simulated, so success rates stay honest', async () => {
    const { postId, targetId } = await seedQueuedPost();
    await setSimulationMode(db, h.tenantA.projectEnvironmentId, true);

    try {
      await executeTarget(db, env, message(postId, targetId), logger);

      const attempts = await listPostAttempts(db, postId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ outcome: 'published', simulated: true });
    } finally {
      await setSimulationMode(db, h.tenantA.projectEnvironmentId, false);
    }
  });

  it('simulates without a usable credential, which is the point of a rehearsal', async () => {
    // A developer rehearsing a launch must get a real answer about whether the content is
    // publishable even when the connection's token has expired. Requiring a working
    // credential would make the mode useless in exactly the case it exists for.
    const { postId, targetId } = await seedQueuedPost();
    await setSimulationMode(db, h.tenantA.projectEnvironmentId, true);

    const stored = await db
      .delete(schema.socialCredentials)
      .where(eq(schema.socialCredentials.connectionId, h.tenantA.connectionId))
      .returning();

    try {
      const result = await executeTarget(db, env, message(postId, targetId), logger);
      expect(result.outcome).toBe('published');
    } finally {
      await setSimulationMode(db, h.tenantA.projectEnvironmentId, false);
      if (stored.length > 0) await db.insert(schema.socialCredentials).values(stored);
    }
  });

  it('retries rather than fails when a provider kill switch is on', async () => {
    // Plan §45. A kill switch is temporary by definition, so permanently failing every
    // post in flight would turn a five-minute mitigation into a day of support tickets.
    const { postId, targetId } = await seedQueuedPost();
    await upsertFeatureFlag(db, {
      key: providerFlagKey('mock'),
      enabled: false,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
    });

    try {
      const result = await executeTarget(db, env, message(postId, targetId), logger);

      expect(result).toMatchObject({
        outcome: 'retryable_failed',
        reason: 'PROVIDER_TEMPORARILY_DISABLED',
      });
      expect(mockStore.all()).toHaveLength(0);

      const after = await getPostWithTargets(db, postId);
      expect(after?.targets[0]?.status).toBe('retryable_failed');
      expect(after?.targets[0]?.nextAttemptAt).not.toBeNull();
    } finally {
      await upsertFeatureFlag(db, {
        key: providerFlagKey('mock'),
        enabled: true,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
      });
    }
  });

  it('publishes normally once the kill switch is off again', async () => {
    const { postId, targetId } = await seedQueuedPost();

    const result = await executeTarget(db, env, message(postId, targetId), logger);
    expect(result.outcome).toBe('published');
    expect(mockStore.all()).toHaveLength(1);
  });

  it('blocks publishing when the connection is disconnected', async () => {
    const { postId, targetId } = await seedQueuedPost();

    await db
      .update(schema.socialConnections)
      .set({ disconnectedAt: new Date(), health: 'disconnected' })
      .where(eq(schema.socialConnections.id, h.tenantA.connectionId));

    try {
      const result = await executeTarget(db, env, message(postId, targetId), logger);
      expect(result.outcome).toBe('permanent_failed');
      expect(result.reason).toBe('CONNECTION_DISCONNECTED');
      // Re-checked at publish time, not trusted from when the post was created.
      expect(mockStore.all()).toHaveLength(0);
    } finally {
      await db
        .update(schema.socialConnections)
        .set({ disconnectedAt: null, health: 'healthy' })
        .where(eq(schema.socialConnections.id, h.tenantA.connectionId));
    }
  });
});
