import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import {
  createHarness,
  databaseUrl,
  executionContext,
  type RouteHarness,
} from '../test-support/harness.js';

/**
 * Social memory route tests, including the tenant-ownership tests Rule 5 requires.
 *
 * The cases worth having:
 *
 *   a fresh profile says why it is empty   `not_enough_data`, not "your content is average"
 *   re-recording a label edits it          rather than accumulating near-duplicates
 *   forgetting is a hard delete            an instruction, not a suggestion
 *   another tenant sees nothing            and cannot address a profile it does not own
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('social memory', () => {
  let h: RouteHarness;
  let readOnlyKey: string;

  beforeAll(async () => {
    h = await createHarness(['content:read', 'content:write', 'analytics:read']);
    readOnlyKey = await h.issueKey(h.tenantA, ['content:read', 'analytics:read']);
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

  const post = (path: string, body: unknown, key?: string) =>
    call(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      key,
    );

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const code = async (response: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(response)).error.code;

  // A getter, not a constant: `h` is assigned in `beforeAll`, which runs after the
  // describe body.
  const profileQuery = () => `profile_id=${h.tenantA.publicProfileId}`;

  describe('brand memory', () => {
    it('records a fact and returns it', async () => {
      const response = await post(
        `/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`,
        { kind: 'product', label: 'Pro plan', body: 'The paid tier, £29 a month.' },
      );

      expect(response.status).toBe(200);

      const body = await json<{ kind: string; label: string; body: string }>(response);
      expect(body.kind).toBe('product');
      expect(body.label).toBe('Pro plan');
    });

    /**
     * Two rows both called "Pro plan" is somebody editing the same fact twice, not two
     * products — and a generation step handed both would have to pick one.
     */
    it('re-recording the same label edits rather than duplicates, ignoring case', async () => {
      await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
        kind: 'product',
        label: 'Starter',
        body: 'First description.',
      });

      await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
        kind: 'product',
        label: 'STARTER',
        body: 'Corrected description.',
      });

      const listed = await json<{ data: { label: string; body: string }[] }>(
        await call(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}&kind=product`),
      );

      const starters = listed.data.filter((entry) => entry.label.toLowerCase() === 'starter');
      expect(starters).toHaveLength(1);
      expect(starters[0]?.body).toBe('Corrected description.');
      // The display casing follows the most recent write.
      expect(starters[0]?.label).toBe('STARTER');
    });

    it('separates kinds, so the same word can be a product and a competitor', async () => {
      await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
        kind: 'competitor',
        label: 'Orbit',
      });
      await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
        kind: 'product',
        label: 'Orbit',
      });

      const competitors = await json<{ data: unknown[] }>(
        await call(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}&kind=competitor`),
      );
      expect(competitors.data).toHaveLength(1);
    });

    it('forgetting is a hard delete', async () => {
      const created = await json<{ id: string }>(
        await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
          kind: 'banned_claim',
          label: 'the fastest',
        }),
      );

      const deleted = await call(`/v1/memory/brand/${created.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);

      const listed = await json<{ data: { id: string }[] }>(
        await call(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}&kind=banned_claim`),
      );
      expect(listed.data.some((entry) => entry.id === created.id)).toBe(false);

      // Gone means gone: a second delete finds nothing rather than succeeding silently.
      const again = await call(`/v1/memory/brand/${created.id}`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    });

    it('requires content:write to record a fact', async () => {
      const response = await post(
        `/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`,
        { kind: 'product', label: 'Nope' },
        readOnlyKey,
      );

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });

    it('rejects an unrecognized kind rather than storing it', async () => {
      const response = await post(`/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`, {
        kind: 'vibes',
        label: 'x',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('performance memory', () => {
    /**
     * A brand-new profile has nothing to say, and the response has to say *that* rather
     * than presenting emptiness as a verdict on the customer's content.
     */
    it('distinguishes "nothing learned yet" from "nothing notable"', async () => {
      const response = await call(`/v1/recommendations?${profileQuery()}`);
      expect(response.status).toBe(200);

      const body = await json<{ data: unknown[]; reason: string }>(response);
      expect(body.data).toEqual([]);
      expect(body.reason).toBe('not_enough_data');
    });

    it('learning over a profile with no analytics writes nothing and says so', async () => {
      const response = await post('/v1/memory/learn', {
        profile_id: h.tenantA.publicProfileId,
        days: 90,
      });

      expect(response.status).toBe(200);

      const body = await json<{ samples_considered: number; observations_written: number }>(
        response,
      );
      expect(body.samples_considered).toBe(0);
      expect(body.observations_written).toBe(0);
    });

    it('is safe to run twice', async () => {
      const first = await post('/v1/memory/learn', { profile_id: h.tenantA.publicProfileId });
      const second = await post('/v1/memory/learn', { profile_id: h.tenantA.publicProfileId });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('refuses a window outside the permitted range', async () => {
      const response = await post('/v1/memory/learn', {
        profile_id: h.tenantA.publicProfileId,
        days: 4000,
      });

      expect(response.status).toBe(400);
    });

    it('returns an empty performance list before anything has been learned', async () => {
      const body = await json<{ data: unknown[] }>(
        await call(`/v1/memory/performance?${profileQuery()}`),
      );
      expect(body.data).toEqual([]);
    });
  });

  describe('tenant ownership', () => {
    it('cannot read another tenant’s brand memory', async () => {
      const response = await call(
        `/v1/memory/brand?profile_id=${h.tenantA.publicProfileId}`,
        {},
        h.tenantB.apiKey,
      );

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('PROFILE_NOT_FOUND');
    });

    it('cannot learn on another tenant’s profile', async () => {
      const response = await post(
        '/v1/memory/learn',
        { profile_id: h.tenantA.publicProfileId },
        h.tenantB.apiKey,
      );

      expect(response.status).toBe(404);
    });

    it('cannot read another tenant’s recommendations', async () => {
      const response = await call(
        `/v1/recommendations?profile_id=${h.tenantA.publicProfileId}`,
        {},
        h.tenantB.apiKey,
      );

      expect(response.status).toBe(404);
    });

    it('requires a profile when the key is not restricted to one', async () => {
      const response = await call('/v1/memory/brand');
      expect(response.status).toBe(400);
      expect(await code(response)).toBe('MISSING_REQUIRED_FIELD');
    });
  });
});
