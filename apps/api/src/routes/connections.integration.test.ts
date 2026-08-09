import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';

/**
 * Connection, destination and capability route tests, including the tenant-ownership
 * tests Rule 5 requires.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('connections and capabilities', () => {
  let h: RouteHarness;
  let restrictedKey: string;

  const SCOPES = [
    'connections:read',
    'connections:write',
    'destinations:read',
    'capabilities:read',
  ] as const;

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

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const code = async (r: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(r)).error.code;

  describe('listing', () => {
    it('returns the tenant’s own connection with its granted scopes', async () => {
      const body = await json<{ data: { id: string; provider: string; granted_scopes: string[] }[] }>(
        await call('/v1/connections'),
      );

      const own = body.data.find((row) => row.id === h.tenantA.publicConnectionId);
      expect(own).toBeDefined();
      expect(own?.provider).toBe('mock');
      expect(own?.granted_scopes).toContain('post.write');
    });

    it('never leaks credential material', async () => {
      // P9/§7.2 — a connection response carries health and scopes, never a token or its
      // ciphertext. Asserting on the serialized body catches a field added later.
      const text = await (await call(`/v1/connections/${h.tenantA.publicConnectionId}`)).text();

      for (const forbidden of ['ciphertext', 'access_token', 'refresh_token', 'nonce', 'key_version']) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('excludes another tenant’s connections', async () => {
      const body = await json<{ data: { id: string }[] }>(await call('/v1/connections?limit=100'));
      expect(body.data.map((r) => r.id)).not.toContain(h.tenantB.publicConnectionId);
    });
  });

  describe('tenant ownership (P5)', () => {
    it('does not return another tenant’s connection', async () => {
      const response = await call(`/v1/connections/${h.tenantB.publicConnectionId}`);
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('CONNECTION_NOT_FOUND');
    });

    it('does not list another tenant’s destinations', async () => {
      const response = await call(`/v1/connections/${h.tenantB.publicConnectionId}/destinations`);
      expect(response.status).toBe(404);
    });

    it('does not disconnect another tenant’s connection', async () => {
      const response = await call(`/v1/connections/${h.tenantB.publicConnectionId}/disconnect`, {
        method: 'POST',
      });
      expect(response.status).toBe(404);

      // And the connection is genuinely still live for its owner.
      const owner = await call(
        `/v1/connections/${h.tenantB.publicConnectionId}`,
        {},
        h.tenantB.apiKey,
      );
      expect((await json<{ health: string }>(owner)).health).toBe('healthy');
    });

    it('does not expose another tenant’s destination capabilities', async () => {
      const response = await call(`/v1/destinations/${h.tenantB.publicDestinationId}/capabilities`);
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('DESTINATION_NOT_FOUND');
    });
  });

  describe('destinations', () => {
    it('lists the destinations behind a connection', async () => {
      const body = await json<{ data: { id: string; destination_type: string; selected: boolean }[] }>(
        await call(`/v1/connections/${h.tenantA.publicConnectionId}/destinations`),
      );

      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(h.tenantA.publicDestinationId);
      expect(body.data[0]?.destination_type).toBe('feed');
      expect(body.data[0]?.selected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('is idempotent', async () => {
      // P4 — a client that retried after a dropped response must not be punished.
      const first = await call(`/v1/connections/${h.tenantA.publicConnectionId}/disconnect`, {
        method: 'POST',
      });
      const second = await call(`/v1/connections/${h.tenantA.publicConnectionId}/disconnect`, {
        method: 'POST',
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await json<{ disconnected: boolean }>(second)).disconnected).toBe(true);
    });

    it('hides a disconnected connection from the default listing', async () => {
      const listed = await json<{ data: { id: string }[] }>(await call('/v1/connections?limit=100'));
      expect(listed.data.map((r) => r.id)).not.toContain(h.tenantA.publicConnectionId);

      const included = await json<{ data: { id: string }[] }>(
        await call('/v1/connections?limit=100&include_disconnected=true'),
      );
      expect(included.data.map((r) => r.id)).toContain(h.tenantA.publicConnectionId);
    });
  });

  describe('profile-restricted keys', () => {
    it('cannot read a connection on another profile', async () => {
      const response = await call(
        `/v1/connections/${h.tenantA.publicConnectionId}`,
        {},
        restrictedKey,
      );
      // Cross-tenant, so the environment filter catches it first and reports not-found.
      expect(response.status).toBe(404);
    });

    it('can read its own profile’s connection', async () => {
      const response = await call(
        `/v1/connections/${h.tenantB.publicConnectionId}`,
        {},
        restrictedKey,
      );
      expect(response.status).toBe(200);
    });
  });

  describe('capabilities (plan §17)', () => {
    it('returns generic capabilities for a platform', async () => {
      const body = await json<{
        provider: string;
        resolution: string;
        publishing: Record<string, boolean>;
        constraints: Record<string, unknown>;
      }>(await call('/v1/platforms/mock/capabilities'));

      expect(body.provider).toBe('mock');
      expect(body.resolution).toBe('generic');
      expect(body.publishing.image).toBe(true);
      expect(body.constraints.max_text_length).toBe(500);
    });

    it('rejects an unknown provider', async () => {
      const response = await call('/v1/platforms/myspace/capabilities');
      expect(response.status).toBe(400);
      expect(await code(response)).toBe('PROVIDER_NOT_SUPPORTED');
    });

    it('resolves effective capabilities for a destination', async () => {
      const body = await json<{ resolution: string; provider: string }>(
        await call(`/v1/destinations/${h.tenantA.publicDestinationId}/capabilities`),
      );

      // The distinction is load-bearing: generic says what the platform does, effective
      // says what this account can do.
      expect(body.resolution).toBe('effective');
      expect(body.provider).toBe('mock');
    });

    it('lists platforms including ones with no adapter yet', async () => {
      const body = await json<{ data: { provider: string; available: boolean; auth_strategy: string | null }[] }>(
        await call('/v1/platforms'),
      );

      const byProvider = new Map(body.data.map((p) => [p.provider, p]));
      expect(byProvider.get('mock')?.available).toBe(true);
      // Listed but unbuilt, so a dashboard renders "coming soon" from the API rather than
      // a hard-coded list that drifts.
      expect(byProvider.get('linkedin')?.available).toBe(false);
      expect(byProvider.get('linkedin')?.auth_strategy ?? null).toBeNull();
    });
  });

  describe('scope enforcement', () => {
    it('refuses a disconnect with only a read scope', async () => {
      const readOnly = await h.issueKey(h.tenantA, ['connections:read']);
      const response = await call(
        `/v1/connections/${h.tenantA.publicConnectionId}/disconnect`,
        { method: 'POST' },
        readOnly,
      );

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });
  });
});
