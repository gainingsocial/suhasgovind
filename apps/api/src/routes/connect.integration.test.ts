import { PROVIDER_NAMES, requiresProviderApp } from '@gs/contracts/providers';
import { getAdapter, hasAdapter } from '@gs/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';

/**
 * The connect flow end to end (plan §21, §22).
 *
 * Runs against the `mock` adapter, which is exactly what it is for: it returns two
 * destinations, so the secondary-selection path in plan §21.3 is exercised rather than
 * assumed, and it does so with no network and no provider approval.
 *
 * Includes the tenant-ownership tests Rule 5 requires for every new route, plus the two
 * properties this flow lives or dies by: state is single-use, and a callback cannot move
 * a connection into a tenant it does not belong to.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

interface AuthorizeResponse {
  object: string;
  authorization_url: string;
  state: string;
  completion: 'redirect' | 'credential';
  required_credential_fields: { name: string; type: string }[];
  expires_at: string;
}

interface CompleteResponse {
  id: string;
  provider: string;
  created: boolean;
  setup_complete: boolean;
  destination_count: number;
}

describeIntegration('connect flow', () => {
  let h: RouteHarness;
  let restrictedKey: string;

  const SCOPES = [
    'connections:read',
    'connections:write',
    'destinations:read',
    'profiles:read',
  ] as const;

  beforeAll(async () => {
    h = await createHarness(SCOPES);
    restrictedKey = await h.issueKey(h.tenantA, SCOPES, {
      restrictToProfileId: h.tenantB.profileId,
    });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const call = async (path: string, init: RequestInit = {}, key?: string): Promise<Response> =>
    await app.request(
      path,
      {
        ...init,
        headers: {
          authorization: `Bearer ${key ?? h.tenantA.apiKey}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      },
      h.env,
      executionContext,
    );

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const code = async (r: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(r)).error.code;

  const authorize = async (profileId = h.tenantA.publicProfileId): Promise<AuthorizeResponse> => {
    const response = await call('/v1/connections/authorize', {
      method: 'POST',
      body: JSON.stringify({
        profile_id: profileId,
        provider: 'mock',
        redirect_url: 'https://customer.example.com/social/callback',
      }),
    });

    expect(response.status).toBe(201);
    return json<AuthorizeResponse>(response);
  };

  describe('starting an authorization', () => {
    it('returns a URL, a state and how to finish', async () => {
      const body = await authorize();

      expect(body.object).toBe('authorization');
      expect(body.authorization_url).toContain('mock.invalid');
      expect(body.state.length).toBeGreaterThanOrEqual(32);
      // `mock` uses the api_key strategy: no consent screen, so the caller collects a
      // field rather than redirecting.
      expect(body.completion).toBe('credential');
      expect(body.required_credential_fields.map((f) => f.name)).toContain('api_key');
      expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects a non-HTTPS redirect url', async () => {
      const response = await call('/v1/connections/authorize', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: h.tenantA.publicProfileId,
          provider: 'mock',
          redirect_url: 'http://customer.example.com/callback',
        }),
      });

      expect(response.status).toBe(400);
      expect(await code(response)).toBe('REDIRECT_URL_NOT_ALLOWED');
    });

    it('reports a platform whose application credentials are missing as unavailable', async () => {
      // Every declared provider now has an adapter, so "no adapter" is unreachable from
      // this route. What remains — and what PLATFORM_APPROVALS.md documents — is a built
      // adapter whose platform application has not been configured yet.
      //
      // Picked dynamically, for the reason the registry test spells out: naming a
      // provider means this breaks the day its credentials land, which is a green-to-red
      // change caused by progress rather than by a regression. Hard-coding `pinterest`
      // here is exactly how it broke when the Pinterest adapter shipped.
      const unconfigured = PROVIDER_NAMES.find(
        (provider) =>
          provider !== 'mock' &&
          hasAdapter(provider) &&
          requiresProviderApp(getAdapter(provider).authStrategy),
      );
      if (!unconfigured) return; // Every OAuth platform is configured; nothing to assert.

      const response = await call('/v1/connections/authorize', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: h.tenantA.publicProfileId,
          provider: unconfigured,
          redirect_url: 'https://customer.example.com/callback',
        }),
      });

      // A 503 saying the platform is not yet available, rather than a 400 implying the
      // caller did something wrong.
      expect(response.status).toBe(503);
      expect(await code(response)).toBe('PROVIDER_NOT_CONFIGURED');
    });
  });

  describe('tenant ownership (P5)', () => {
    it('will not authorize against another tenant’s profile', async () => {
      const response = await call('/v1/connections/authorize', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: h.tenantB.publicProfileId,
          provider: 'mock',
          redirect_url: 'https://customer.example.com/callback',
        }),
      });

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('PROFILE_NOT_FOUND');
    });

    it('will not authorize against a profile the key is restricted away from', async () => {
      const response = await call(
        '/v1/connections/authorize',
        {
          method: 'POST',
          body: JSON.stringify({
            profile_id: h.tenantA.publicProfileId,
            provider: 'mock',
            redirect_url: 'https://customer.example.com/callback',
          }),
        },
        restrictedKey,
      );

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });

    it('will not let another tenant’s key finish this tenant’s handshake', async () => {
      const started = await authorize();

      const response = await call(
        '/v1/connections/complete',
        {
          method: 'POST',
          body: JSON.stringify({ state: started.state, credentials: { api_key: 'k' } }),
        },
        h.tenantB.apiKey,
      );

      // The session names tenant A; a tenant B key presenting it is refused, and the
      // refusal does not distinguish "wrong tenant" from "no such state".
      expect(await code(response)).toBe('AUTHORIZATION_SESSION_INVALID');
    });

    it('will not refresh another tenant’s connection', async () => {
      const response = await call(`/v1/connections/${h.tenantB.publicConnectionId}/refresh`, {
        method: 'POST',
      });

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('CONNECTION_NOT_FOUND');
    });

    it('will not select destinations on another tenant’s connection', async () => {
      const response = await call(
        `/v1/connections/${h.tenantB.publicConnectionId}/destinations/select`,
        { method: 'POST', body: JSON.stringify({ destination_ids: [] }) },
      );

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('CONNECTION_NOT_FOUND');
    });
  });

  describe('completing an authorization', () => {
    it('creates a connection and reports that setup is incomplete', async () => {
      const started = await authorize();

      const response = await call('/v1/connections/complete', {
        method: 'POST',
        body: JSON.stringify({
          state: started.state,
          credentials: { api_key: 'mock-key-value' },
        }),
      });

      expect(response.status).toBe(201);
      const body = await json<CompleteResponse>(response);

      expect(body.provider).toBe('mock');
      expect(body.id.startsWith('con_')).toBe(true);
      expect(body.destination_count).toBe(2);
      // Two destinations means the user has to choose. Auto-selecting both would publish
      // to a feed nobody asked for, which is not recoverable after the fact.
      expect(body.setup_complete).toBe(false);
    });

    it('is single-use: the same state cannot be replayed', async () => {
      const started = await authorize();

      const first = await call('/v1/connections/complete', {
        method: 'POST',
        body: JSON.stringify({ state: started.state, credentials: { api_key: 'k' } }),
      });
      expect(first.status).toBe(201);

      const replay = await call('/v1/connections/complete', {
        method: 'POST',
        body: JSON.stringify({ state: started.state, credentials: { api_key: 'k' } }),
      });

      expect(replay.status).toBe(400);
      expect(await code(replay)).toBe('AUTHORIZATION_SESSION_INVALID');
    });

    it('rejects an unknown state', async () => {
      const response = await call('/v1/connections/complete', {
        method: 'POST',
        body: JSON.stringify({
          state: 'not-a-real-state-value-at-all',
          credentials: { api_key: 'k' },
        }),
      });

      expect(await code(response)).toBe('AUTHORIZATION_SESSION_INVALID');
    });

    it('reconnecting the same account updates rather than duplicating', async () => {
      const first = await json<CompleteResponse>(
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: (await authorize()).state,
            credentials: { api_key: 'k' },
          }),
        }),
      );

      const second = await json<CompleteResponse>(
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: (await authorize()).state,
            credentials: { api_key: 'k2' },
          }),
        }),
      );

      // Same provider account, same profile — one connection. Two would mean a post
      // targeting "the mock connection" published twice.
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
    });

    it('never returns credential material', async () => {
      const started = await authorize();
      const text = await (
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({ state: started.state, credentials: { api_key: 'super-secret' } }),
        })
      ).text();

      // P9/§7.2 — what went in must not come back out, in any form.
      for (const forbidden of ['super-secret', 'ciphertext', 'nonce', 'key_version']) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  describe('destination selection (plan §21.3)', () => {
    it('completes setup once a destination is chosen', async () => {
      const connection = await json<CompleteResponse>(
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: (await authorize()).state,
            credentials: { api_key: 'k' },
          }),
        }),
      );

      const destinations = await json<{ data: { id: string; selected: boolean }[] }>(
        await call(`/v1/connections/${connection.id}/destinations`),
      );
      expect(destinations.data.length).toBe(2);
      expect(destinations.data.every((d) => !d.selected)).toBe(true);

      const chosen = destinations.data[0]!.id;
      const selected = await json<{ data: { id: string; selected: boolean }[] }>(
        await call(`/v1/connections/${connection.id}/destinations/select`, {
          method: 'POST',
          body: JSON.stringify({ destination_ids: [chosen] }),
        }),
      );

      expect(selected.data.find((d) => d.id === chosen)?.selected).toBe(true);
      expect(selected.data.filter((d) => d.selected).length).toBe(1);

      const after = await json<{ setup_completed_at: string | null }>(
        await call(`/v1/connections/${connection.id}`),
      );
      expect(after.setup_completed_at).not.toBeNull();
    });

    it('rejects a destination id belonging to another connection', async () => {
      const connection = await json<CompleteResponse>(
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: (await authorize()).state,
            credentials: { api_key: 'k' },
          }),
        }),
      );

      const response = await call(`/v1/connections/${connection.id}/destinations/select`, {
        method: 'POST',
        body: JSON.stringify({ destination_ids: [h.tenantA.publicDestinationId] }),
      });

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('DESTINATION_NOT_FOUND');
    });
  });

  describe('refresh', () => {
    it('reports that nothing rotated for a credential that does not expire', async () => {
      const connection = await json<CompleteResponse>(
        await call('/v1/connections/complete', {
          method: 'POST',
          body: JSON.stringify({
            state: (await authorize()).state,
            credentials: { api_key: 'k' },
          }),
        }),
      );

      const response = await call(`/v1/connections/${connection.id}/refresh`, { method: 'POST' });

      expect(response.status).toBe(200);
      const body = await json<{ health: string; rotated: boolean }>(response);
      expect(body.health).toBe('healthy');
      // An api_key credential has nothing to rotate. Saying so lets the engine skip a
      // pointless re-encrypt rather than writing the same value back.
      expect(body.rotated).toBe(false);
    });

    it('reports a connection with no stored credential as needing re-authorization', async () => {
      // The seeded fixture connection deliberately has no credential row, which is the
      // same state a partially-failed connect leaves behind. It must be reported as
      // re-auth required, not as an internal error.
      const response = await call(`/v1/connections/${h.tenantA.publicConnectionId}/refresh`, {
        method: 'POST',
      });

      expect(response.status).toBe(409);
      expect(await code(response)).toBe('CONNECTION_REAUTH_REQUIRED');
    });
  });

  describe('hosted connect sessions (plan §22)', () => {
    it('returns a signed URL scoped to one profile', async () => {
      const response = await call('/v1/connect-sessions', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: h.tenantA.publicProfileId,
          providers: ['mock'],
          branding: { company_name: 'Acme', accent: '#FFC800' },
          return_url: 'https://customer.example.com/settings',
          expires_in: 900,
        }),
      });

      expect(response.status).toBe(201);
      const body = await json<{ url: string; providers: string[]; expires_at: string }>(response);

      expect(body.providers).toEqual(['mock']);
      expect(body.url).toContain('/connect/');
      expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('will not create a session for another tenant’s profile', async () => {
      const response = await call('/v1/connect-sessions', {
        method: 'POST',
        body: JSON.stringify({ profile_id: h.tenantB.publicProfileId }),
      });

      expect(response.status).toBe(404);
      expect(await code(response)).toBe('PROFILE_NOT_FOUND');
    });

    it('serves the hosted page for a valid token and refuses a forged one', async () => {
      const session = await json<{ url: string }>(
        await call('/v1/connect-sessions', {
          method: 'POST',
          body: JSON.stringify({ profile_id: h.tenantA.publicProfileId, providers: ['mock'] }),
        }),
      );

      const path = new URL(session.url).pathname;
      const page = await app.request(path, {}, h.env, executionContext);

      expect(page.status).toBe(200);
      expect(page.headers.get('x-robots-tag')).toContain('noindex');
      expect(page.headers.get('cache-control')).toContain('no-store');

      const html = await page.text();
      expect(html).toContain('Connect your accounts');
      expect(html).toContain('Mock Provider');

      // A token whose signature does not verify never reaches a database lookup.
      const forged = await app.request(
        '/connect/eyJhbGciOiJub25lIn0.forged',
        {},
        h.env,
        executionContext,
      );
      expect(forged.status).toBe(400);
      expect(await code(forged)).toBe('CONNECT_SESSION_INVALID');
    });

    it('will not connect a platform the session does not offer', async () => {
      const session = await json<{ url: string }>(
        await call('/v1/connect-sessions', {
          method: 'POST',
          body: JSON.stringify({ profile_id: h.tenantA.publicProfileId, providers: ['bluesky'] }),
        }),
      );

      const path = new URL(session.url).pathname;
      const response = await app.request(
        `${path}/authorize`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'mock' }),
        },
        h.env,
        executionContext,
      );

      expect(await code(response)).toBe('PROVIDER_NOT_SUPPORTED');
    });
  });
});
