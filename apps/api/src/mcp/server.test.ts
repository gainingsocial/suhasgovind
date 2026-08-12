import { describe, expect, it } from 'vitest';

import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMcpRequest,
  negotiateVersion,
  type McpContext,
} from './server.js';
import { MCP_TOOLS, SEARCH_TOOL, searchTools } from './tools.js';

/**
 * MCP protocol conformance (plan §50).
 *
 * Two revisions are served from one implementation, and the differences between them are
 * exactly the kind of thing that works in development and fails against a real client:
 * a `resultType` omitted, a cache hint sent to a client that has no field for it, an
 * `initialize` refused because the newer spec deleted the method.
 */

const dispatched: Request[] = [];

function context(response = new Response('{"ok":true}', { status: 200 })): McpContext {
  return {
    dispatch: (request) => {
      dispatched.push(request);
      return response.clone();
    },
    origin: 'https://api.test',
    authorization: 'Bearer sk_test_key',
    requestId: 'req_1',
    traceId: 'trc_1',
  };
}

const rpc = (method: string, params?: Record<string, unknown>, meta?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method,
  ...(params ? { params } : {}),
  ...(meta ? { _meta: meta } : {}),
});

const STATELESS_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };

describe('version negotiation', () => {
  it('treats an initialize call as a pre-stateless client', () => {
    // The 2026 revision deleted this method, so seeing it is conclusive regardless of any
    // header an intermediary may have added.
    const result = negotiateVersion(rpc('initialize', { protocolVersion: '2025-06-18' }), null);
    expect(result).toEqual({ version: '2025-06-18', stateless: false });
  });

  it('reads the protocol version from _meta', () => {
    expect(negotiateVersion(rpc('tools/list', {}, STATELESS_META), null)).toMatchObject({
      version: '2026-07-28',
      stateless: true,
    });
  });

  it('falls back to the mirrored HTTP header when _meta is absent', () => {
    // Intermediaries are allowed to route on the header, and some strip the body they
    // routed on. The body is the source of truth; the header is the backup.
    expect(negotiateVersion(rpc('tools/list'), '2026-07-28')).toMatchObject({ stateless: true });
  });

  it('assumes the newest revision when nothing declares one', () => {
    expect(negotiateVersion(rpc('tools/list'), null).version).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('ignores a version it does not support rather than echoing it back', () => {
    const result = negotiateVersion(rpc('tools/list'), '1999-01-01');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(result.version);
  });

  it('answers an initialize for an unsupported version with one it does support', () => {
    const result = negotiateVersion(rpc('initialize', { protocolVersion: '1999-01-01' }), null);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(result.version);
  });
});

describe('lifecycle', () => {
  it('answers the legacy initialize handshake', async () => {
    // A client speaking 2025-06-18 is older, not broken. Refusing it would break a working
    // integration on our schedule rather than theirs.
    const result = (await handleMcpRequest(
      rpc('initialize', { protocolVersion: '2025-06-18' }),
      null,
      context(),
    )) as { result: { protocolVersion: string; serverInfo: unknown; instructions: string } };

    expect(result.result.protocolVersion).toBe('2025-06-18');
    expect(result.result.serverInfo).toMatchObject({ name: 'gaining-social' });
    expect(result.result.instructions).toContain('202');
  });

  it('answers server/discover for stateless clients', async () => {
    const result = (await handleMcpRequest(rpc('server/discover'), null, context())) as {
      result: { protocolVersion: string };
    };

    expect(result.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('returns nothing at all for a notification', async () => {
    // A notification carries no id, so returning a response would itself be a protocol
    // error.
    expect(await handleMcpRequest(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      null,
      context(),
    )).toBeNull();
  });

  it('answers ping', async () => {
    expect(await handleMcpRequest(rpc('ping'), null, context())).toMatchObject({ result: {} });
  });

  it('rejects something that is not a JSON-RPC request', async () => {
    expect(await handleMcpRequest({ hello: 'world' }, null, context())).toMatchObject({
      error: { code: -32600 },
    });
  });

  it('reports an unknown method rather than failing silently', async () => {
    expect(await handleMcpRequest(rpc('resources/list'), null, context())).toMatchObject({
      error: { code: -32601 },
    });
  });
});

describe('tools/list', () => {
  it('lists every curated tool plus discovery', async () => {
    const result = (await handleMcpRequest(rpc('tools/list'), null, context())) as {
      result: { tools: { name: string }[] };
    };

    const names = result.result.tools.map((tool) => tool.name);
    expect(names).toContain('create_post');
    expect(names).toContain('search_tools');
    expect(names).toHaveLength(MCP_TOOLS.length + 1);
  });

  it('keeps the default set small enough to fit a prompt', () => {
    // Plan §50: "Do not expose 300+ tools in every prompt context." A server that dumps
    // its whole surface has spent the model's attention before the task begins.
    expect(MCP_TOOLS.length).toBeLessThanOrEqual(20);
  });

  it('sends cache hints only to clients whose revision defines them', async () => {
    const stateless = (await handleMcpRequest(
      rpc('tools/list', {}, STATELESS_META),
      null,
      context(),
    )) as { result: { ttlMs?: number; cacheScope?: string } };

    expect(stateless.result).toMatchObject({ ttlMs: 300_000, cacheScope: 'public' });

    const legacy = (await handleMcpRequest(
      { ...rpc('tools/list'), _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } },
      null,
      context(),
    )) as { result: { ttlMs?: number } };

    expect(legacy.result.ttlMs).toBeUndefined();
  });

  it('marks publishing tools as destructive so a client can confirm first', async () => {
    const result = (await handleMcpRequest(rpc('tools/list'), null, context())) as {
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    };

    const byName = new Map(result.result.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('create_post')?.annotations.readOnlyHint).toBe(false);
    expect(byName.get('list_posts')?.annotations.readOnlyHint).toBe(true);
  });

  it('gives every tool a JSON schema a model can fill in', async () => {
    const result = (await handleMcpRequest(rpc('tools/list'), null, context())) as {
      result: { tools: { name: string; description: string; inputSchema: { type?: string } }[] };
    };

    for (const tool of result.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('tools/call', () => {
  it('dispatches to the matching REST route with the caller’s credentials', async () => {
    dispatched.length = 0;
    const ctx = context();

    await handleMcpRequest(
      rpc('tools/call', { name: 'list_profiles', arguments: { limit: 5 } }),
      null,
      ctx,
    );

    const sent = dispatched.at(-1)!;
    expect(sent.method).toBe('GET');
    expect(new URL(sent.url).pathname).toBe('/v1/profiles');
    expect(new URL(sent.url).searchParams.get('limit')).toBe('5');
    // Forwarded verbatim: an MCP client gets exactly the scopes its key carries.
    expect(sent.headers.get('authorization')).toBe('Bearer sk_test_key');
  });

  it('propagates the trace so an agent’s action is one thread in the logs', async () => {
    dispatched.length = 0;
    await handleMcpRequest(
      rpc('tools/call', { name: 'list_profiles', arguments: {} }),
      null,
      context(),
    );

    expect(dispatched.at(-1)!.headers.get('x-trace-id')).toBe('trc_1');
  });

  it('supplies an idempotency key for create_post when the caller omits one', async () => {
    dispatched.length = 0;
    await handleMcpRequest(
      rpc('tools/call', {
        name: 'create_post',
        arguments: {
          profile_id: 'pro_x',
          content: { text: 'hello', media_ids: [] },
          targets: [{ destination_id: 'dst_x' }],
        },
      }),
      null,
      context(),
    );

    expect(dispatched.at(-1)!.headers.get('idempotency-key')).toMatch(/^mcp_/);
  });

  it('uses the caller’s idempotency key when one is given', async () => {
    dispatched.length = 0;
    await handleMcpRequest(
      rpc('tools/call', {
        name: 'create_post',
        arguments: {
          profile_id: 'pro_x',
          content: { text: 'hello', media_ids: [] },
          targets: [{ destination_id: 'dst_x' }],
          idempotency_key: 'agent-run-42',
        },
      }),
      null,
      context(),
    );

    const sent = dispatched.at(-1)!;
    expect(sent.headers.get('idempotency-key')).toBe('agent-run-42');
    // And it is not smuggled into the body as an unknown field.
    expect(await sent.clone().text()).not.toContain('idempotency_key');
  });

  it('reports bad arguments as a tool error the model can act on', async () => {
    // A JSON-RPC error is a transport fault some clients never surface to the model. A tool
    // error carrying the field problems is something it can read and fix next call.
    const result = (await handleMcpRequest(
      rpc('tools/call', { name: 'create_post', arguments: { profile_id: 123 } }),
      null,
      context(),
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(result.result.isError).toBe(true);
    expect(result.result.content[0]?.text).toContain('INVALID_ARGUMENTS');
    expect(result.result.content[0]?.text).toContain('issues');
  });

  it('passes a 4xx envelope through as tool output rather than swallowing it', async () => {
    const failing = new Response(
      JSON.stringify({
        error: { code: 'PROFILE_NOT_FOUND', message: 'No such profile.', agent_action: 'x' },
      }),
      { status: 404 },
    );

    const result = (await handleMcpRequest(
      rpc('tools/call', { name: 'list_profiles', arguments: {} }),
      null,
      context(failing),
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(result.result.isError).toBe(true);
    // The structure that makes recovery possible survives.
    expect(result.result.content[0]?.text).toContain('agent_action');
  });

  it('adds resultType only for revisions that define it', async () => {
    const stateless = (await handleMcpRequest(
      rpc('tools/call', { name: 'list_profiles', arguments: {} }, STATELESS_META),
      null,
      context(),
    )) as { result: { resultType?: string } };

    expect(stateless.result.resultType).toBe('complete');

    const legacy = (await handleMcpRequest(
      {
        ...rpc('tools/call', { name: 'list_profiles', arguments: {} }),
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
      },
      null,
      context(),
    )) as { result: { resultType?: string } };

    expect(legacy.result.resultType).toBeUndefined();
  });

  it('refuses an unknown tool name', async () => {
    expect(
      await handleMcpRequest(rpc('tools/call', { name: 'delete_everything' }), null, context()),
    ).toMatchObject({ error: { code: -32602 } });
  });
});

describe('search_tools', () => {
  it('finds a tool by topic rather than exact name', () => {
    expect(searchTools('why did it fail').map((tool) => tool.name)).toContain('get_post_timeline');
    expect(searchTools('outage').map((tool) => tool.name)).toContain('get_provider_status');
    expect(searchTools('character limit').map((tool) => tool.name)).toContain('get_capabilities');
  });

  it('ranks a name match above a passing mention', () => {
    expect(searchTools('capabilities')[0]?.name).toBe('get_capabilities');
  });

  it('returns everything for an empty query rather than nothing', () => {
    expect(searchTools('')).toHaveLength(MCP_TOOLS.length);
  });

  it('answers through tools/call like any other tool', async () => {
    const result = (await handleMcpRequest(
      rpc('tools/call', { name: SEARCH_TOOL.name, arguments: { query: 'webhook' } }),
      null,
      context(),
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(result.result.isError).toBe(false);
    expect(result.result.content[0]?.text).toContain('webhook');
  });

  it('says so plainly when nothing matches', async () => {
    const result = (await handleMcpRequest(
      rpc('tools/call', { name: SEARCH_TOOL.name, arguments: { query: 'zzzzqqqq' } }),
      null,
      context(),
    )) as { result: { content: { text: string }[] } };

    expect(result.result.content[0]?.text).toContain('tools/list');
  });
});
