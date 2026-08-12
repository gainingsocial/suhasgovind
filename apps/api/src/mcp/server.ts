import { z } from 'zod';

import { MCP_TOOLS, SEARCH_TOOL, TOOLS_BY_NAME, searchTools, type McpTool } from './tools.js';

/**
 * MCP server (plan §50, Phase 8).
 *
 * Two protocol eras, one implementation:
 *
 *   2026-07-28  stateless. No handshake, no session id. Every request carries its own
 *               protocol version and client info in `_meta`, results carry `resultType`,
 *               and list results carry cache hints.
 *   2025-06-18  the `initialize` / `notifications/initialized` handshake.
 *
 * Both are served because a protocol revision does not upgrade the clients already
 * deployed. Detection is per request rather than per connection — which is the whole point
 * of the newer revision, and means a stateless server never has to remember which era a
 * caller belongs to.
 *
 * Specification consulted:
 *   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
 *   https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 */

export const LATEST_PROTOCOL_VERSION = '2026-07-28';

/** Every revision this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;

/** The `_meta` key carrying the protocol version in the stateless era. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

/**
 * How long a client may cache `tools/list`.
 *
 * Five minutes, and `public` because the tool table is identical for every caller — it is
 * derived from code, not from the caller's data. Scoping it `private` would make every
 * agent re-fetch an identical list, which is exactly the waste the cache hint exists to
 * remove. What a caller may *do* with a tool still varies by key, and that is enforced at
 * call time by the same scope check a REST request passes through.
 */
const TOOLS_CACHE_TTL_MS = 300_000;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface DispatchResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Issues a request against the API's own routes.
 *
 * Supplied by the caller rather than imported, because the app imports this module and a
 * module that imported the app back would be a cycle. It also keeps this file testable
 * without standing up the whole application.
 */
export type InternalDispatch = (request: Request) => Promise<Response> | Response;

export interface McpContext {
  dispatch: InternalDispatch;
  /** The origin internal requests are addressed to. Never leaves this process. */
  origin: string;
  /** Forwarded verbatim, so a tool call is authorized exactly as a REST call would be. */
  authorization: string | null;
  requestId: string;
  traceId: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: string | number | null | undefined, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * Which revision this request belongs to.
 *
 * The `_meta` field is the source of truth per the 2026 transport spec; the HTTP header
 * mirrors it for intermediaries. An `initialize` call identifies a pre-stateless client
 * regardless of either, since the newer revision removed that method entirely.
 */
export function negotiateVersion(
  request: JsonRpcRequest,
  header: string | null,
): { version: string; stateless: boolean } {
  if (request.method === 'initialize') {
    const requested = asString(request.params?.protocolVersion);
    const version =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : '2025-06-18';
    return { version, stateless: false };
  }

  const declared = asString(request._meta?.[META_PROTOCOL_VERSION]) ?? header;

  // An undeclared version means a stateless client that omitted it, or an intermediary
  // that stripped the header. Assuming the newest is right far more often than assuming
  // the oldest, and a stateless response is a superset a legacy client tolerates.
  const version =
    declared && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(declared)
      ? declared
      : LATEST_PROTOCOL_VERSION;

  return { version, stateless: version >= '2026-07-28' };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: 'gaining-social',
  title: 'Gaining Social',
  version: '0.1.0',
} as const;

/**
 * Told to the model before it does anything.
 *
 * Front-loads the two facts that stop the most common agent mistakes: publishing is
 * asynchronous (so a 202 is not a success), and capabilities are knowable in advance (so
 * guessing at a character limit is never necessary).
 */
const INSTRUCTIONS = [
  'Publish to social networks through one API.',
  '',
  'Work in this order: list_profiles → list_connections → list_destinations →',
  'get_capabilities → compose_post or preflight_post → create_post.',
  '',
  'Two things that trip up agents here:',
  '1. create_post returns 202, not a published post. Publishing happens asynchronously.',
  '   Poll get_post, and treat partial success as normal — some networks can succeed while',
  '   others fail.',
  '2. Never guess a platform limit. get_capabilities and compose_post tell you the real',
  '   ones for that specific account, which differ by account type and approval state.',
  '',
  'If something fails, call get_post_timeline before retrying. A permanent failure will',
  'fail again identically, and retrying it wastes the attempt budget a transient one needs.',
].join('\n');

function serverCapabilities() {
  return { tools: { listChanged: false } };
}

function toolDefinition(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchemaFor(tool.inputSchema),
    annotations: {
      // `readOnlyHint` lets a client decide whether to confirm before calling, and lets an
      // agent policy separate reading from acting (plan §48.6).
      readOnlyHint: !tool.destructive,
      destructiveHint: tool.destructive,
      idempotentHint: !tool.destructive,
    },
  };
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
  delete generated.$schema;
  return generated;
}

/**
 * Wrap a tool result in the shape the negotiated revision expects.
 *
 * `resultType` is required from 2026-07-28 and absent before it. Sending it to an older
 * client is harmless, but omitting it from a newer one is a protocol violation — so it is
 * added only when the caller asked for a revision that defines it.
 */
function toolResult(payload: unknown, isError: boolean, stateless: boolean): unknown {
  const base = {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError,
  };

  return stateless ? { ...base, resultType: 'complete' } : base;
}

// ---------------------------------------------------------------------------

export async function handleMcpRequest(
  raw: unknown,
  header: string | null,
  context: McpContext,
): Promise<unknown> {
  if (!isJsonRpc(raw)) {
    return fail(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request object.');
  }

  const request = raw;
  const { version, stateless } = negotiateVersion(request, header);

  switch (request.method) {
    /**
     * Pre-stateless handshake. Answered rather than rejected, because a client speaking
     * 2025-06-18 is not misconfigured — it is simply older than the revision that removed
     * this method, and refusing it would break a working integration on our schedule.
     */
    case 'initialize':
      return ok(request.id, {
        protocolVersion: version,
        capabilities: serverCapabilities(),
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    /** The stateless replacement for `initialize`. Same information, no session. */
    case 'server/discover':
      return ok(request.id, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: serverCapabilities(),
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // Notifications carry no id and take no response. Returning one would be a protocol
      // error, so the transport layer drops what this returns.
      return null;

    case 'ping':
      return ok(request.id, {});

    case 'tools/list': {
      const tools = [...MCP_TOOLS, SEARCH_TOOL].map(toolDefinition);

      return ok(request.id, {
        tools,
        ...(stateless ? { ttlMs: TOOLS_CACHE_TTL_MS, cacheScope: 'public' } : {}),
      });
    }

    case 'tools/call':
      return callTool(request, stateless, context);

    default:
      return fail(request.id, METHOD_NOT_FOUND, `Unknown method "${request.method}".`);
  }
}

async function callTool(
  request: JsonRpcRequest,
  stateless: boolean,
  context: McpContext,
): Promise<unknown> {
  const name = asString(request.params?.name);
  const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

  if (!name) return fail(request.id, INVALID_PARAMS, '`name` is required.');

  if (name === SEARCH_TOOL.name) {
    const query = asString(args.query) ?? '';
    const matches = searchTools(query).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));

    return ok(
      request.id,
      toolResult(
        matches.length > 0
          ? { matches }
          : { matches: [], hint: 'No tool matches that. Call tools/list to see everything.' },
        false,
        stateless,
      ),
    );
  }

  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return fail(request.id, INVALID_PARAMS, `Unknown tool "${name}".`);

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    /**
     * Reported as a tool error, not a JSON-RPC error.
     *
     * A JSON-RPC error is a transport fault the model cannot act on and some clients do
     * not surface at all. A tool error carrying the specific field problems is something
     * the model can read and fix on the next call, which is the entire point of the
     * agent-native error design (plan §16).
     */
    return ok(
      request.id,
      toolResult(
        {
          error: 'INVALID_ARGUMENTS',
          message: `Arguments for ${name} are not valid.`,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        true,
        stateless,
      ),
    );
  }

  let spec;
  try {
    spec = tool.buildRequest(parsed.data as Record<string, unknown>);
  } catch (error) {
    return fail(
      request.id,
      INTERNAL_ERROR,
      error instanceof Error ? error.message : 'Failed to build the request.',
    );
  }

  const url = new URL(spec.path, context.origin);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Propagated so an MCP tool call and the request it becomes share one trace, and a
    // support question about "what did the agent do" has a single thread to pull.
    'x-request-id': context.requestId,
    'x-trace-id': context.traceId,
  };
  if (context.authorization) headers.authorization = context.authorization;
  if (spec.idempotencyKey) headers['idempotency-key'] = spec.idempotencyKey;
  else if (spec.method === 'POST' && spec.path === '/v1/posts') {
    /**
     * A generated key still protects the caller.
     *
     * It covers the case that matters most in an agent loop — a dropped response leading
     * to an immediate retry of the same call — but it cannot deduplicate two calls the
     * agent decided to make. The tool description says so rather than implying more safety
     * than exists.
     */
    headers['idempotency-key'] = `mcp_${crypto.randomUUID()}`;
  }

  const response = await context.dispatch(
    new Request(url.toString(), {
      method: spec.method,
      headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    }),
  );

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = { error: 'UNPARSEABLE_RESPONSE', body: text.slice(0, 500) };
  }

  /**
   * A 4xx is a tool error, not a transport error.
   *
   * The body is our agent-native envelope — a stable code, a message, and an
   * `agent_action` naming what to do next. Handing that to the model as tool output is
   * what lets it recover; collapsing it into a JSON-RPC error string throws away the
   * structure that makes recovery possible.
   */
  return ok(request.id, toolResult(payload, !response.ok, stateless));
}

// ---------------------------------------------------------------------------

function isJsonRpc(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export const MCP_ERROR_CODES = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} as const;

export { META_CLIENT_INFO, META_PROTOCOL_VERSION, TOOLS_CACHE_TTL_MS };
