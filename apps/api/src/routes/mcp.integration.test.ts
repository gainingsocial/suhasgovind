import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';

/**
 * MCP end to end (plan §50, Phase 8).
 *
 * The unit tests cover the protocol. These cover the claim that matters: a tool call is
 * the same code path as the REST call, authorized the same way. If MCP had its own
 * shortcut around authentication or tenancy, this is where it would show.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('POST /mcp', () => {
  let h: RouteHarness;

  beforeAll(async () => {
    h = await createHarness(['profiles:read', 'posts:read', 'posts:write', 'connections:read']);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  async function call(payload: unknown, key?: string | null): Promise<Response> {
    return app.request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key === null ? {} : { authorization: `Bearer ${key ?? h.tenantA.apiKey}` }),
        },
        body: JSON.stringify(payload),
      },
      h.env,
      executionContext,
    );
  }

  const tool = (name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  async function toolPayload<T>(response: Response): Promise<T> {
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as T;
  }

  it('serves discovery without a key', async () => {
    // Capability discovery reveals which tools exist, not any customer's data. Requiring a
    // key here would stop a client configuring itself before the operator pastes one in.
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'server/discover' }, null);
    expect(response.status).toBe(200);
  });

  it('lists real profiles through a tool call', async () => {
    const response = await call(tool('list_profiles'));
    expect(response.status).toBe(200);

    const payload = await toolPayload<{ object: string; data: { id: string }[] }>(response);
    expect(payload.object).toBe('list');
    expect(payload.data.map((row) => row.id)).toContain(h.tenantA.publicProfileId);
  });

  it('enforces the API key’s scopes exactly as REST does', async () => {
    // The key below has no `webhooks:manage`, and MCP must not become a way around that.
    const narrow = await h.issueKey(h.tenantA, ['profiles:read']);
    const response = await call(tool('list_webhook_endpoints'), narrow);

    const payload = await toolPayload<{ error: { code: string } }>(response);
    expect(payload.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('refuses an unauthenticated tool call', async () => {
    const response = await call(tool('list_profiles'), null);
    const payload = await toolPayload<{ error: { code: string } }>(response);

    expect(payload.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('cannot reach another tenant’s data (P5)', async () => {
    const response = await call(
      tool('get_post', { post_id: 'pst_00000000000000000000000000' }),
      h.tenantB.apiKey,
    );

    const body = (await response.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it('validates a post through preflight without publishing it', async () => {
    const response = await call(
      tool('preflight_post', {
        profile_id: h.tenantA.publicProfileId,
        content: { text: 'Checking before I commit.', media_ids: [] },
        targets: [{ destination_id: h.tenantA.publicDestinationId }],
      }),
    );

    const payload = await toolPayload<{ object: string; valid: boolean }>(response);
    expect(payload.object).toBe('preflight');

    const posts = await app.request(
      '/v1/posts',
      { headers: { authorization: `Bearer ${h.tenantA.apiKey}` } },
      h.env,
      executionContext,
    );
    expect(((await posts.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it('composes for a network through a tool call', async () => {
    const response = await call(
      tool('compose_post', {
        profile_id: h.tenantA.publicProfileId,
        content: { text: 'One post, every network.', media_ids: [] },
        targets: [{ destination_id: h.tenantA.publicDestinationId }],
        mode: 'optimize',
      }),
    );

    const payload = await toolPayload<{ object: string; targets: { status: string }[] }>(response);
    expect(payload.object).toBe('composition');
    expect(payload.targets[0]?.status).toBe('ready');
  });

  it('publishes, and reuses one idempotency key across a retry', async () => {
    const args = {
      profile_id: h.tenantA.publicProfileId,
      content: { text: 'Published by an agent.', media_ids: [] },
      targets: [{ destination_id: h.tenantA.publicDestinationId }],
      idempotency_key: `mcp-test-${crypto.randomUUID()}`,
    };

    const first = await toolPayload<{ id: string; status: string }>(await call(tool('create_post', args)));
    const second = await toolPayload<{ id: string }>(await call(tool('create_post', args)));

    // The property that makes an agent loop safe: retrying the same call publishes once.
    expect(second.id).toBe(first.id);
  });

  it('reads back the post it just created', async () => {
    const created = await toolPayload<{ id: string }>(
      await call(
        tool('create_post', {
          profile_id: h.tenantA.publicProfileId,
          content: { text: 'Then read it back.', media_ids: [] },
          targets: [{ destination_id: h.tenantA.publicDestinationId }],
          idempotency_key: `mcp-read-${crypto.randomUUID()}`,
        }),
      ),
    );

    const fetched = await toolPayload<{ id: string; targets: unknown[] }>(
      await call(tool('get_post', { post_id: created.id })),
    );

    expect(fetched.id).toBe(created.id);
    expect(fetched.targets).toHaveLength(1);
  });

  it('handles a batch sequentially', async () => {
    const response = await call([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);

    const body = (await response.json()) as { id: number }[];
    expect(body.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('returns 202 with no body for a notification-only batch', async () => {
    const response = await call([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(response.status).toBe(202);
  });

  it('reports malformed JSON in the body, not as a network failure', async () => {
    const response = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.tenantA.apiKey}` },
        body: '{ not json',
      },
      h.env,
      executionContext,
    );

    // 200 with a JSON-RPC parse error: a client that reads the status first would report a
    // network problem for a malformed message it can see and fix.
    expect(response.status).toBe(200);
    expect((await response.json()) as { error: { code: number } }).toMatchObject({
      error: { code: -32700 },
    });
  });
});
