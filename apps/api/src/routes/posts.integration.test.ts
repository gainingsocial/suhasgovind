import { newUuidV7, toPublicId } from '@gs/contracts/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';

/**
 * Publishing route tests.
 *
 * These cover the Phase-1 required tests from plan §64 that live at the API boundary:
 * a duplicate idempotency key creates one post, two simultaneous calls create one post,
 * and target ownership cannot cross a profile or project. They are the most important
 * tests in the project — everything else can be fixed after the fact, but a duplicate
 * published post cannot be unpublished.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('posts', () => {
  let h: RouteHarness;
  let restrictedKey: string;

  const SCOPES = ['posts:read', 'posts:write', 'profiles:read'] as const;

  beforeAll(async () => {
    h = await createHarness(SCOPES);
    restrictedKey = await h.issueKey(h.tenantB, SCOPES, {
      restrictToProfileId: h.tenantB.profileId,
    });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const call = async (path: string, init: RequestInit = {}, key?: string): Promise<Response> =>
    await app.request(
      path,
      { ...init, headers: { authorization: `Bearer ${key ?? h.tenantA.apiKey}`, ...init.headers } },
      h.env,
      executionContext,
    );

  const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
  const code = async (r: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(r)).error.code;

  const body = (overrides: Record<string, unknown> = {}, tenant = h?.tenantA) => ({
    profile_id: tenant.publicProfileId,
    content: { text: 'Hello from the integration suite.', media_ids: [] },
    targets: [{ destination_id: tenant.publicDestinationId }],
    ...overrides,
  });

  const createPost = (payload: unknown, idemKey: string, key?: string) =>
    call(
      '/v1/posts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
        body: JSON.stringify(payload),
      },
      key,
    );

  describe('creation', () => {
    it('returns 202 with queued targets, never 200', async () => {
      // Plan §15 — the work is accepted, not completed. Reliable publication must never
      // depend on the client holding a connection open.
      const response = await createPost(body(), crypto.randomUUID());
      expect(response.status).toBe(202);

      const post = await json<{
        id: string;
        status: string;
        targets: { id: string; status: string; provider: string }[];
        request_id: string;
      }>(response);

      expect(post.id).toMatch(/^pst_/);
      expect(post.status).toBe('queued');
      expect(post.targets).toHaveLength(1);
      expect(post.targets[0]?.id).toMatch(/^ptg_/);
      expect(post.targets[0]?.status).toBe('queued');
      expect(post.targets[0]?.provider).toBe('mock');
      expect(post.request_id).toMatch(/^req_/);
    });

    it('requires an Idempotency-Key', async () => {
      // A duplicate published post cannot be undone, so the caller must give us something
      // to deduplicate on.
      const response = await call('/v1/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });

      expect(response.status).toBe(400);
      expect(await code(response)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('schedules rather than queues when publish_at is set', async () => {
      const publishAt = new Date(Date.now() + 3_600_000).toISOString();
      const response = await createPost(body({ publish_at: publishAt }), crypto.randomUUID());

      const post = await json<{ status: string; publish_at: string; targets: { status: string }[] }>(
        response,
      );
      expect(post.status).toBe('scheduled');
      expect(post.targets[0]?.status).toBe('scheduled');
      expect(post.publish_at).toBe(publishAt);
    });
  });

  describe('effective-once (ADR-006 Layer 1)', () => {
    it('creates one post when the same idempotency key is used twice', async () => {
      const key = crypto.randomUUID();
      const payload = body();

      const first = await createPost(payload, key);
      const second = await createPost(payload, key);

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);

      const a = await json<{ id: string }>(first);
      const b = await json<{ id: string }>(second);

      // Same post, not two. The second response is the stored snapshot replayed.
      expect(b.id).toBe(a.id);
    });

    it('creates one post when two identical calls race', async () => {
      // The case a naive check-then-insert loses: both callers see no existing key, and
      // both create a post. The reservation has to be atomic for this to hold.
      const key = crypto.randomUUID();
      const payload = body();

      const [first, second] = await Promise.all([
        createPost(payload, key),
        createPost(payload, key),
      ]);

      const statuses = [first.status, second.status].sort();
      const bodies = await Promise.all([json<Record<string, unknown>>(first), json<Record<string, unknown>>(second)]);

      // One of three legitimate shapes: both replay the same post, or the loser is told
      // the request is still in flight and should retry. What must never happen is two
      // different post ids.
      const ids = bodies
        .map((b) => (b as { id?: string }).id)
        .filter((id): id is string => typeof id === 'string');

      if (ids.length === 2) {
        expect(ids[0]).toBe(ids[1]);
      } else {
        expect(statuses).toContain(409);
      }

      // And the database agrees: exactly one post carries this key.
      const rows = await h.handle.sql`
        select count(*)::int as n
        from posts p
        join idempotency_keys k on k.id = p.idempotency_key_id
        where k.key = ${key}
      `;
      expect(rows[0]?.n).toBe(1);
    });

    it('rejects the same key with a different body', async () => {
      const key = crypto.randomUUID();

      await createPost(body(), key);
      const conflict = await createPost(body({ content: { text: 'Different', media_ids: [] } }), key);

      expect(conflict.status).toBe(409);
      expect(await code(conflict)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('records a content fingerprint on every target', async () => {
      // ADR-006 Layer 3. Without it, reconciliation after an ambiguous timeout has
      // nothing to match a possible orphan against.
      const response = await createPost(body(), crypto.randomUUID());
      const post = await json<{ id: string }>(response);

      const rows = await h.handle.sql`
        select t.content_fingerprint
        from post_targets t
        join posts p on p.id = t.post_id
        where p.request_id is not null
        order by t.id desc
        limit 1
      `;

      expect(post.id).toMatch(/^pst_/);
      expect(rows[0]?.content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('tenant ownership (P5)', () => {
    it('refuses a destination belonging to another tenant', async () => {
      const response = await createPost(
        body({ targets: [{ destination_id: h.tenantB.publicDestinationId }] }),
        crypto.randomUUID(),
      );

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('DESTINATION_NOT_FOUND');
    });

    it('answers another tenant’s destination exactly as it answers one that does not exist', async () => {
      // The assertion is the *equality*, not either value.
      //
      // These used to differ: an id belonging to another tenant threw 403, while an id
      // matching nothing was never checked here at all and fell through. That gap is an
      // existence oracle — someone who had guessed or scraped a destination id could
      // confirm it was real by whether the refusal came back 403 rather than 404, without
      // ever having access to it.
      const foreign = await createPost(
        body({ targets: [{ destination_id: h.tenantB.publicDestinationId }] }),
        crypto.randomUUID(),
      );

      // Well-formed and correctly prefixed, so it gets past id parsing and reaches the
      // same lookup — it simply matches no row.
      const invented = await createPost(
        body({ targets: [{ destination_id: toPublicId('destination', newUuidV7()) }] }),
        crypto.randomUUID(),
      );

      expect(invented.status).toBe(foreign.status);
      expect(await code(invented)).toBe(await code(foreign));
    });

    it('refuses a profile belonging to another tenant', async () => {
      const response = await createPost(
        body({ profile_id: h.tenantB.publicProfileId }),
        crypto.randomUUID(),
      );
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('PROFILE_NOT_FOUND');
    });

    it('refuses a destination on a different profile in the same tenant', async () => {
      // 403 here, deliberately unlike the 404 a cross-tenant destination gets. This one
      // belongs to the caller's own organization — they can already list it — so hiding
      // the reason would protect nothing and only make their own data harder to use. The
      // boundary worth being silent at is the tenant, not the profile.
      const otherProfile = await json<{ id: string }>(
        await call('/v1/profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Other profile' }),
        }, await h.issueKey(h.tenantA, ['profiles:write'])),
      );

      const response = await createPost(
        body({ profile_id: otherProfile.id, targets: [{ destination_id: h.tenantA.publicDestinationId }] }),
        crypto.randomUUID(),
      );

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });

    it('does not return another tenant’s post', async () => {
      const mine = await json<{ id: string }>(await createPost(body(), crypto.randomUUID()));

      const response = await call(`/v1/posts/${mine.id}`, {}, h.tenantB.apiKey);
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('POST_NOT_FOUND');
    });

    it('never lists another tenant’s posts', async () => {
      await createPost(body(), crypto.randomUUID());

      const listed = await json<{ data: { id: string }[] }>(
        await call('/v1/posts?limit=100', {}, h.tenantB.apiKey),
      );
      const mine = await json<{ data: { id: string }[] }>(await call('/v1/posts?limit=100'));

      const theirIds = new Set(listed.data.map((p) => p.id));
      for (const post of mine.data) expect(theirIds.has(post.id)).toBe(false);
    });
  });

  describe('request validation', () => {
    it('rejects the same destination listed twice', async () => {
      // Publishing to it twice is the exact duplicate the whole design prevents,
      // arriving through the front door.
      const response = await createPost(
        body({
          targets: [
            { destination_id: h.tenantA.publicDestinationId },
            { destination_id: h.tenantA.publicDestinationId },
          ],
        }),
        crypto.randomUUID(),
      );

      // 422, not 400: the request is well-formed, the targets are semantically invalid.
      expect(response.status).toBe(422);
      expect(await code(response)).toBe('DUPLICATE_DESTINATION');
    });

    it('rejects a schedule in the past', async () => {
      const response = await createPost(
        body({ publish_at: new Date(Date.now() - 60_000).toISOString() }),
        crypto.randomUUID(),
      );

      expect(response.status).toBe(422);
      expect(await code(response)).toBe('VALIDATION_FAILED');
    });

    it('rejects text longer than the destination allows', async () => {
      // The mock caps at 500. Preflight catches it before anything is written, so the
      // failure is synchronous and attributable to the request.
      const response = await createPost(
        body({ content: { text: 'x'.repeat(501), media_ids: [] } }),
        crypto.randomUUID(),
      );

      expect(response.status).toBe(422);
      const error = await json<{ error: { code: string; details: { code: string }[] } }>(response);
      expect(error.error.code).toBe('VALIDATION_FAILED');
      expect(error.error.details.map((d) => d.code)).toContain('TEXT_TOO_LONG');
    });

    it('rejects media that is not ready', async () => {
      const response = await createPost(
        body({ content: { text: 'With media', media_ids: ['med_01k1q9m4pz7f3v8h2n6d0rjxab'] } }),
        crypto.randomUUID(),
      );
      expect(response.status).toBe(422);
    });
  });

  describe('preflight (plan §18)', () => {
    it('returns 200 with valid: true for publishable content', async () => {
      const response = await call('/v1/posts/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });

      expect(response.status).toBe(200);
      const result = await json<{ valid: boolean; targets: { valid: boolean; provider: string }[] }>(
        response,
      );
      expect(result.valid).toBe(true);
      expect(result.targets[0]?.provider).toBe('mock');
    });

    it('returns 200 with valid: false rather than a 4xx', async () => {
      // Preflight succeeded at its job — reporting problems is the job. A 4xx would make
      // "your content has a warning" look like "your request was malformed".
      const response = await call('/v1/posts/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body({ content: { text: 'x'.repeat(501), media_ids: [] } })),
      });

      expect(response.status).toBe(200);
      const result = await json<{
        valid: boolean;
        targets: { valid: boolean; errors: { code: string; agent_action: string }[] }[];
      }>(response);

      expect(result.valid).toBe(false);
      const error = result.targets[0]?.errors.find((e) => e.code === 'TEXT_TOO_LONG');
      expect(error).toBeDefined();
      // Plan §16 — an agent must never have to parse English to decide what to do.
      expect(error?.agent_action).toBe('shorten_text');
    });

    it('creates nothing', async () => {
      const before = await h.handle.sql`select count(*)::int as n from posts`;
      await call('/v1/posts/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });
      const after = await h.handle.sql`select count(*)::int as n from posts`;

      expect(after[0]?.n).toBe(before[0]?.n);
    });
  });

  describe('lifecycle', () => {
    it('cancels queued targets', async () => {
      const post = await json<{ id: string }>(await createPost(body(), crypto.randomUUID()));

      const response = await call(`/v1/posts/${post.id}/cancel`, { method: 'POST' });
      expect(response.status).toBe(200);

      const result = await json<{ cancelled_targets: number; status: string }>(response);
      expect(result.cancelled_targets).toBe(1);
      expect(result.status).toBe('cancelled');
    });

    it('reports zero requeued when nothing is retryable', async () => {
      const post = await json<{ id: string }>(await createPost(body(), crypto.randomUUID()));

      const response = await call(`/v1/posts/${post.id}/retry`, { method: 'POST' });
      expect(response.status).toBe(202);
      expect((await json<{ requeued_targets: number }>(response)).requeued_targets).toBe(0);
    });
  });

  describe('profile-restricted keys', () => {
    it('cannot publish for another profile', async () => {
      const response = await createPost(
        body({}, h.tenantA),
        crypto.randomUUID(),
        restrictedKey,
      );
      // The key restriction is checked before the lookup, so this is a 403 rather than
      // the 404 an unrestricted cross-tenant key would get.
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });

    it('can publish for its own profile', async () => {
      const response = await createPost(body({}, h.tenantB), crypto.randomUUID(), restrictedKey);
      expect(response.status).toBe(202);
    });
  });

  describe('scope enforcement', () => {
    it('refuses a publish with only a read scope', async () => {
      const readOnly = await h.issueKey(h.tenantA, ['posts:read', 'profiles:read']);
      const response = await createPost(body(), crypto.randomUUID(), readOnly);

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });
  });
});
