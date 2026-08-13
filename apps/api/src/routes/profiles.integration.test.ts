import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';

/**
 * Profile route tests, including the tenant-ownership tests Rule 5 requires.
 *
 * These run against a real database because that is where isolation actually lives: in
 * WHERE clauses and foreign keys. A fake repository would happily "isolate" tenants that
 * production would not.
 *
 * One harness for the whole file. Seeding an organization costs several sequential round
 * trips to a remote database; the scope and restriction cases mint extra keys against the
 * existing tenants instead, which costs two.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('profiles', () => {
  let h: RouteHarness;
  let readOnlyKey: string;
  let writeOnlyKey: string;
  let restrictedKey: string;

  beforeAll(async () => {
    h = await createHarness(['profiles:read', 'profiles:write']);

    [readOnlyKey, writeOnlyKey, restrictedKey] = await Promise.all([
      h.issueKey(h.tenantA, ['profiles:read']),
      h.issueKey(h.tenantA, ['profiles:write']),
      h.issueKey(h.tenantB, ['profiles:read', 'profiles:write'], {
        restrictToProfileId: h.tenantB.profileId,
      }),
    ]);
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

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const code = async (response: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(response)).error.code;

  const create = (body: unknown, key?: string) =>
    call(
      '/v1/profiles',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      key,
    );

  describe('creation', () => {
    it('creates a profile and returns a prefixed opaque id', async () => {
      const response = await create({ name: 'Acme Coffee', timezone: 'America/New_York' });
      expect(response.status).toBe(201);

      const body = await json<{ id: string; object: string; timezone: string; created_at: string }>(response);

      // Plan §13.1 — never a sequential id, never a bare UUID.
      expect(body.id).toMatch(/^pro_[0-9a-hjkmnp-tv-z]+$/);
      expect(body.object).toBe('profile');
      expect(body.timezone).toBe('America/New_York');
      // Rule 15 — UTC ISO-8601.
      expect(body.created_at).toMatch(/Z$/);
    });

    it('rejects an invalid timezone rather than storing it', async () => {
      // A regex would accept this, and the failure would surface much later as a
      // scheduled post firing at the wrong time.
      const response = await create({ name: 'Bad TZ', timezone: 'Not/AReal_Zone' });
      expect(response.status).toBe(400);
      expect(await code(response)).toBe('INVALID_REQUEST');
    });

    it('conflicts on a duplicate external_id within the environment', async () => {
      const payload = { name: 'Dup', external_id: `ext-${crypto.randomUUID()}` };

      expect((await create(payload)).status).toBe(201);

      const second = await create(payload);
      expect(second.status).toBe(409);
      expect(await code(second)).toBe('RESOURCE_ALREADY_EXISTS');
    });

    it('allows the same external_id in a different tenant', async () => {
      // Uniqueness is per environment, not global. A global constraint would let one
      // customer discover another's identifiers by probing for conflicts.
      const payload = { name: 'Same key', external_id: `shared-${crypto.randomUUID()}` };

      expect((await create(payload, h.tenantA.apiKey)).status).toBe(201);
      expect((await create(payload, h.tenantB.apiKey)).status).toBe(201);
    });
  });

  describe('tenant ownership (P5)', () => {
    it('does not return another tenant profile by id', async () => {
      const response = await call(`/v1/profiles/${h.tenantB.publicProfileId}`, {}, h.tenantA.apiKey);
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('PROFILE_NOT_FOUND');
    });

    it('does not update another tenant profile, and does not write to it', async () => {
      const response = await call(
        `/v1/profiles/${h.tenantB.publicProfileId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'hijacked' }),
        },
        h.tenantA.apiKey,
      );
      expect(response.status).toBe(404);

      // A 404 that still performed the write would be worse than no check at all.
      const owner = await call(`/v1/profiles/${h.tenantB.publicProfileId}`, {}, h.tenantB.apiKey);
      expect((await json<{ name: string }>(owner)).name).not.toBe('hijacked');
    });

    it('does not delete another tenant profile', async () => {
      const response = await call(
        `/v1/profiles/${h.tenantB.publicProfileId}`,
        { method: 'DELETE' },
        h.tenantA.apiKey,
      );
      expect(response.status).toBe(404);

      const stillThere = await call(`/v1/profiles/${h.tenantB.publicProfileId}`, {}, h.tenantB.apiKey);
      expect(stillThere.status).toBe(200);
    });

    it('never includes another tenant profile in a list', async () => {
      const body = await json<{ data: { id: string }[] }>(
        await call('/v1/profiles?limit=100', {}, h.tenantA.apiKey),
      );

      const ids = body.data.map((p) => p.id);
      expect(ids).not.toContain(h.tenantB.publicProfileId);
      expect(ids).toContain(h.tenantA.publicProfileId);
    });
  });

  describe('scope enforcement', () => {
    it('refuses a write with only a read scope', async () => {
      const response = await create({ name: 'Should not exist' }, readOnlyKey);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });

    it('refuses a read with only a write scope', async () => {
      // `:write` deliberately does not imply `:read` — enumerating profiles is a
      // different capability from creating one.
      const response = await call('/v1/profiles', {}, writeOnlyKey);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });
  });

  describe('profile-restricted keys (plan §38)', () => {
    it('sees only its own profile', async () => {
      const body = await json<{ data: { id: string }[] }>(
        await call('/v1/profiles?limit=100', {}, restrictedKey),
      );

      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(h.tenantB.publicProfileId);
    });

    it('cannot create additional profiles', async () => {
      // The grant means "act on this one profile". A profile it creates would be one it
      // immediately could not see.
      const response = await create({ name: 'Not allowed' }, restrictedKey);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });

    it('cannot read a sibling profile in its own tenant', async () => {
      const sibling = await json<{ id: string }>(
        await create({ name: 'Sibling' }, h.tenantB.apiKey),
      );

      const response = await call(`/v1/profiles/${sibling.id}`, {}, restrictedKey);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });
  });

  describe('pagination', () => {
    it('pages without skipping or repeating rows', async () => {
      const paged = await createHarness(['profiles:read', 'profiles:write']);
      try {
        const post = (name: string) =>
          app.request(
            '/v1/profiles',
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${paged.tenantA.apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ name }),
            },
            paged.env,
            executionContext,
          );

        // Checked, not fired and forgotten. These five run concurrently against a pooled
        // connection, and a create that loses a connection under load used to surface at
        // the bottom of this test as "expected 6, got 5" — a pagination assertion failing
        // for a reason that has nothing to do with pagination. Asserting here means a
        // flaky create says so where it happened.
        const created = await Promise.all([0, 1, 2, 3, 4].map((i) => post(`Page ${i}`)));
        expect(created.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);

        const seen: string[] = [];
        let cursor: string | null = null;

        for (let page = 0; page < 10; page += 1) {
          const url: string = `/v1/profiles?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
          const response: Response = await app.request(
            url,
            { headers: { authorization: `Bearer ${paged.tenantA.apiKey}` } },
            paged.env,
            executionContext,
          );
          const body = await json<{
            data: { id: string }[];
            has_more: boolean;
            next_cursor: string | null;
          }>(response);

          seen.push(...body.data.map((p) => p.id));
          if (!body.has_more) break;
          cursor = body.next_cursor;
        }

        // 5 created + 1 seeded by the harness, each exactly once.
        expect(seen).toHaveLength(6);
        expect(new Set(seen).size).toBe(6);
      } finally {
        await paged.cleanup();
      }
    });
  });

  describe('update semantics', () => {
    it('leaves absent fields alone and clears explicit nulls', async () => {
      const created = await json<{ id: string }>(
        await create({
          name: 'Patch me',
          external_id: `patch-${crypto.randomUUID()}`,
          timezone: 'Europe/Berlin',
        }),
      );

      const patch = (body: unknown) =>
        call(`/v1/profiles/${created.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      // An absent `timezone` must not reset it to the default.
      const patched = await json<{ timezone: string; name: string; external_id: string | null }>(
        await patch({ name: 'Patched' }),
      );
      expect(patched.name).toBe('Patched');
      expect(patched.timezone).toBe('Europe/Berlin');
      expect(patched.external_id).not.toBeNull();

      // An explicit null clears.
      const cleared = await json<{ external_id: string | null }>(await patch({ external_id: null }));
      expect(cleared.external_id).toBeNull();
    });

    it('rejects an empty patch', async () => {
      const response = await call(`/v1/profiles/${h.tenantA.publicProfileId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('id handling', () => {
    it('rejects a well-formed id of the wrong resource kind', async () => {
      // `pst_…` is a post. Looking it up and 404ing would imply it might exist.
      const response = await call('/v1/profiles/pst_01k1q9m4pz7f3v8h2n6d0rjxab');
      expect(response.status).toBe(400);
      expect(await code(response)).toBe('INVALID_REQUEST');
    });

    it('soft-deletes so the row survives for in-flight work', async () => {
      const created = await json<{ id: string }>(await create({ name: 'Delete me' }));

      const deleted = await call(`/v1/profiles/${created.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect((await json<{ deleted: boolean }>(deleted)).deleted).toBe(true);

      // Gone from the API...
      expect((await call(`/v1/profiles/${created.id}`)).status).toBe(404);

      // ...but still in the database, so a queued target can still resolve its ownership
      // chain instead of failing unresolvably.
      const rows = await h.handle
        .sql`select deleted_at from profiles where name = 'Delete me' limit 1`;
      expect(rows[0]?.deleted_at).not.toBeNull();
    });
  });
});
