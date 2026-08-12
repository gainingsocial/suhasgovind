import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import {
  LATEST_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
  handleMcpRequest,
  type InternalDispatch as _InternalDispatch,
} from '../mcp/server.js';

/**
 * The MCP endpoint (plan §50, Phase 8).
 *
 * Streamable HTTP: one POST per message to a single endpoint. Every tool call is dispatched
 * against this application's own routes, so it runs the same middleware, the same
 * authorization and the same handler a REST caller reaches. Plan §50 forbids duplicate
 * social logic, and calling the code is a stronger guarantee than agreeing not to copy it.
 *
 * Authentication is the ordinary API key, forwarded verbatim. An MCP client is a client:
 * it gets exactly the scopes its key carries and no more, and the profile restriction on a
 * key applies to an agent exactly as it applies to a script. OAuth 2.1 for MCP (plan §51)
 * layers on top of this later; it does not replace it, because a static key is what most
 * agent deployments actually hold today.
 */
export type McpDispatch = (
  request: Request,
  env: AppEnv['Bindings'],
  /**
   * Typed loosely on purpose. Hono declares its own `ExecutionContext` and the Workers
   * runtime declares a generic one; they are structurally the same object and only the
   * declarations disagree. The cast happens once, where the app is wired.
   */
  ctx: unknown,
) => Promise<Response> | Response;

export function createMcpRoute(dispatch: McpDispatch): Hono<AppEnv> {
  const mcp = new Hono<AppEnv>();

  /**
   * Advertised so a client can discover the endpoint and its revision without a round
   * trip, and so a human hitting the URL in a browser gets something other than a 405.
   */
  mcp.get('/', (c) =>
    c.json({
      object: 'mcp_server',
      protocol_version: LATEST_PROTOCOL_VERSION,
      transport: 'streamable-http',
      endpoint: new URL('/mcp', c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin).toString(),
      authentication: 'Send your API key as `Authorization: Bearer sk_…`.',
    }),
  );

  mcp.post('/', async (c) => {
    const trace = c.get('trace');

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: MCP_ERROR_CODES.PARSE_ERROR, message: 'Request body is not valid JSON.' },
        },
        // 200, not 400. A JSON-RPC transport carries protocol errors in the body, and a
        // client that reads the status first would report a network problem for what is
        // actually a malformed message it can see and fix.
        200,
      );
    }

    /**
     * Batches are accepted because JSON-RPC defines them and some clients send them.
     * Handled sequentially: a batch containing two `create_post` calls executed in parallel
     * would race the idempotency reservation, and the whole point of that reservation is
     * that concurrent identical calls produce one post.
     */
    if (Array.isArray(payload)) {
      const responses = [];
      for (const entry of payload) {
        const result = await handleMcpRequest(entry, c.req.header('mcp-protocol-version') ?? null, {
          dispatch: (request) => dispatch(request, c.env, c.executionCtx),
          origin: new URL(c.req.url).origin,
          authorization: c.req.header('authorization') ?? null,
          requestId: trace.requestId,
          traceId: trace.traceId,
        });
        // Notifications produce no response and must not appear in the batch reply.
        if (result !== null) responses.push(result);
      }

      // An all-notification batch gets 202 with no body, per JSON-RPC.
      return responses.length > 0 ? c.json(responses, 200) : c.body(null, 202);
    }

    const result = await handleMcpRequest(payload, c.req.header('mcp-protocol-version') ?? null, {
      dispatch: (request) => dispatch(request, c.env, c.executionCtx),
      origin: new URL(c.req.url).origin,
      authorization: c.req.header('authorization') ?? null,
      requestId: trace.requestId,
      traceId: trace.traceId,
    });

    return result === null ? c.body(null, 202) : c.json(result, 200);
  });

  return mcp;
}
