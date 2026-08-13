import {
  CancelPostResponseSchema,
  ComposeArticleRequestSchema,
  ComposeArticleResponseSchema,
  ComposeRequestSchema,
  ComposeResponseSchema,
  ConnectionListResponseSchema,
  CreatePostRequestSchema,
  MediaSchema,
  PostListResponseSchema,
  PostSchema,
  PostTimelineResponseSchema,
  PreflightRequestSchema,
  PreflightResponseSchema,
  ProfileListResponseSchema,
  ProviderHealthResponseSchema,
  RetryPostResponseSchema,
  WebhookDeliveryListResponseSchema,
  WebhookEndpointListResponseSchema,
} from '@gs/contracts/http';
import type { ApiScope } from '@gs/contracts/scopes';
import { z } from 'zod';

/**
 * The curated MCP tool set (plan §50, Phase 8).
 *
 * Every tool is a thin description of an existing REST route. There is no business logic
 * here and there must never be: plan §50 is explicit that MCP consumes the same service
 * layer, and a second implementation of "what does publishing mean" is how the agent
 * surface and the REST surface start disagreeing about a customer's post.
 *
 * The table is deliberately small. An agent's context is finite, and a server that dumps
 * three hundred tool definitions into every prompt has spent the model's attention before
 * the task begins — which is why §50 pairs a small default set with `search_tools`.
 */

/**
 * How a tool call becomes an internal request.
 *
 * The dispatcher issues this against the API's own Hono app, so a tool call runs the exact
 * middleware stack, the exact authorization checks and the exact handler a REST caller
 * would reach. Sharing the code by *calling* it is stronger than sharing it by discipline.
 */
export interface ToolRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Required on `POST /v1/posts`, and generated when the caller omits one. */
  idempotencyKey?: string;
}

export interface McpTool {
  readonly name: string;
  /** Written for a model deciding whether to call it, not for a human browsing docs. */
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly scopes: readonly ApiScope[];
  /** Keywords `search_tools` matches against, beyond the name and description. */
  readonly keywords: readonly string[];
  /**
   * True when the tool causes something a customer would notice — a published post, a
   * cancelled one. Surfaced as an annotation so a client can require confirmation, and so
   * an agent policy can distinguish reading from acting (plan §48.6).
   */
  readonly destructive: boolean;
  readonly buildRequest: (args: Record<string, unknown>) => ToolRequest;
  /** The response schema, so the OpenAPI document and the tool agree by construction. */
  readonly outputSchema?: z.ZodType;
}

const PaginationArgs = {
  limit: z.number().int().min(1).max(100).optional().describe('How many to return. Default 25.'),
  cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
};

const profileId = z.string().describe('Public profile id, `pro_…`.');

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'list_profiles',
    description:
      'List the profiles (downstream customers, brands or creators) in this environment. ' +
      'Start here: almost every other tool needs a profile id.',
    inputSchema: z.object(PaginationArgs),
    scopes: ['profiles:read'],
    keywords: ['profile', 'brand', 'customer', 'tenant', 'account'],
    destructive: false,
    outputSchema: ProfileListResponseSchema,
    buildRequest: (args) => ({
      method: 'GET',
      path: '/v1/profiles',
      query: { limit: str(args.limit), cursor: str(args.cursor) },
    }),
  },
  {
    name: 'list_connections',
    description:
      'List connected social accounts and their health. A connection whose health is not ' +
      '`healthy` cannot publish, and the health value says why.',
    inputSchema: z.object({
      profile_id: profileId.optional(),
      provider: z.string().optional().describe('Filter to one platform, e.g. `linkedin`.'),
      ...PaginationArgs,
    }),
    scopes: ['connections:read'],
    keywords: ['connection', 'account', 'linked', 'auth', 'health', 'token'],
    destructive: false,
    outputSchema: ConnectionListResponseSchema,
    buildRequest: (args) => ({
      method: 'GET',
      path: '/v1/connections',
      query: {
        profile_id: str(args.profile_id),
        provider: str(args.provider),
        limit: str(args.limit),
        cursor: str(args.cursor),
      },
    }),
  },
  {
    name: 'list_destinations',
    description:
      'List the publishable surfaces behind a connection — Pages, organizations, boards, ' +
      'channels. Posts target destinations, never connections.',
    inputSchema: z.object({
      connection_id: z.string().describe('Public connection id, `con_…`.'),
    }),
    scopes: ['destinations:read'],
    keywords: ['destination', 'page', 'channel', 'board', 'organization', 'target'],
    destructive: false,
    buildRequest: (args) => ({
      method: 'GET',
      path: `/v1/connections/${String(args.connection_id)}/destinations`,
    }),
  },
  {
    name: 'get_capabilities',
    description:
      'What a destination can actually do: post types, character limits, media formats, ' +
      'aspect ratios, durations. Call this before composing rather than guessing, and ' +
      'before reporting that something is impossible.',
    inputSchema: z.object({
      destination_id: z.string().describe('Public destination id, `dst_…`.'),
    }),
    scopes: ['capabilities:read'],
    keywords: ['capability', 'limit', 'constraint', 'specification', 'supported', 'format'],
    destructive: false,
    buildRequest: (args) => ({
      method: 'GET',
      path: `/v1/destinations/${String(args.destination_id)}/capabilities`,
    }),
  },
  {
    name: 'compose_post',
    description:
      'Prepare one piece of writing for several networks at once and see exactly what each ' +
      'would publish, including any text or media adaptation. Returns a `publish_override` ' +
      'per destination — pass those to create_post to publish precisely what was previewed. ' +
      'Composing never publishes.',
    inputSchema: composeArgs(),
    scopes: ['posts:read'],
    keywords: ['compose', 'adapt', 'preview', 'optimize', 'variant', 'draft'],
    destructive: false,
    outputSchema: ComposeResponseSchema,
    buildRequest: (args) => ({ method: 'POST', path: '/v1/compose', body: args }),
  },
  {
    name: 'share_article',
    description:
      'Turn a published article into per-network posts. Give it the headline, the URL, the ' +
      'body and optionally a featured image and tags; it registers the image, derives a ' +
      'summary from the author’s own words — never rewriting them — and returns what each ' +
      'network would publish plus a `publish_override` to hand to create_post. Use this ' +
      'rather than composing an article by hand: it is the same derivation every ' +
      'integration uses, so the post reads identically however it was triggered. Sharing ' +
      'never publishes.',
    inputSchema: ComposeArticleRequestSchema,
    scopes: ['posts:read', 'media:write'],
    keywords: ['article', 'blog', 'post', 'share', 'wordpress', 'cms', 'url', 'link', 'repurpose'],
    destructive: false,
    outputSchema: ComposeArticleResponseSchema,
    buildRequest: (args) => ({ method: 'POST', path: '/v1/articles/compose', body: args }),
  },
  {
    name: 'preflight_post',
    description:
      'Validate a post without publishing it. Takes the same body as create_post, performs ' +
      'no side effect, and is safe to call as often as you like. Findings carry an ' +
      '`agent_action` naming what to do next.',
    inputSchema: postArgs(),
    scopes: ['posts:read'],
    keywords: ['validate', 'check', 'preflight', 'dry run', 'lint'],
    destructive: false,
    outputSchema: PreflightResponseSchema,
    buildRequest: (args) => ({ method: 'POST', path: '/v1/posts/preflight', body: args }),
  },
  {
    name: 'create_post',
    description:
      'Publish or schedule a post to one or more destinations. Returns 202 with per-target ' +
      'status; publishing is asynchronous, so poll get_post or subscribe to webhooks rather ' +
      'than assuming success. Call preflight_post first — a rejected post cannot be undone ' +
      'and a duplicate published post cannot be unpublished.',
    inputSchema: postArgs(),
    scopes: ['posts:write'],
    keywords: ['publish', 'post', 'schedule', 'send', 'create'],
    destructive: true,
    outputSchema: PostSchema,
    buildRequest: (args) => ({
      method: 'POST',
      path: '/v1/posts',
      body: omit(args, ['idempotency_key']),
      idempotencyKey: str(args.idempotency_key),
    }),
  },
  {
    name: 'get_post',
    description:
      'One post with the current status of every target. Use this to follow an accepted ' +
      'post to completion, including partial success where some networks published and ' +
      'others did not.',
    inputSchema: z.object({ post_id: z.string().describe('Public post id, `pst_…`.') }),
    scopes: ['posts:read'],
    keywords: ['status', 'post', 'result', 'progress'],
    destructive: false,
    outputSchema: PostSchema,
    buildRequest: (args) => ({ method: 'GET', path: `/v1/posts/${String(args.post_id)}` }),
  },
  {
    name: 'list_posts',
    description: 'Recent posts with rolled-up target counts, newest first.',
    inputSchema: z.object({
      profile_id: profileId.optional(),
      status: z.string().optional().describe('Filter by post status, e.g. `failed`.'),
      ...PaginationArgs,
    }),
    scopes: ['posts:read'],
    keywords: ['history', 'posts', 'recent', 'list'],
    destructive: false,
    outputSchema: PostListResponseSchema,
    buildRequest: (args) => ({
      method: 'GET',
      path: '/v1/posts',
      query: {
        profile_id: str(args.profile_id),
        status: str(args.status),
        limit: str(args.limit),
        cursor: str(args.cursor),
      },
    }),
  },
  {
    name: 'get_post_timeline',
    description:
      'Every attempt made against every target of a post, with normalized error codes and ' +
      'timings. This is the tool that answers "why did this fail?" — reach for it before ' +
      'retrying anything.',
    inputSchema: z.object({ post_id: z.string().describe('Public post id, `pst_…`.') }),
    scopes: ['posts:read'],
    keywords: ['timeline', 'attempt', 'debug', 'why', 'error', 'failure'],
    destructive: false,
    outputSchema: PostTimelineResponseSchema,
    buildRequest: (args) => ({
      method: 'GET',
      path: `/v1/posts/${String(args.post_id)}/timeline`,
    }),
  },
  {
    name: 'cancel_post',
    description:
      'Cancel a post that has not published yet. Targets already published are unaffected — ' +
      'cancelling cannot retract something a platform has already shown to people.',
    inputSchema: z.object({ post_id: z.string().describe('Public post id, `pst_…`.') }),
    scopes: ['posts:write'],
    keywords: ['cancel', 'stop', 'abort', 'unschedule'],
    destructive: true,
    outputSchema: CancelPostResponseSchema,
    buildRequest: (args) => ({
      method: 'POST',
      path: `/v1/posts/${String(args.post_id)}/cancel`,
    }),
  },
  {
    name: 'retry_failed_targets',
    description:
      'Re-queue the failed targets of a post. Safe to call twice: the execution lease and ' +
      'content fingerprint prevent a duplicate publish. Check get_post_timeline first — a ' +
      'permanent failure will fail again identically.',
    inputSchema: z.object({ post_id: z.string().describe('Public post id, `pst_…`.') }),
    scopes: ['posts:write'],
    keywords: ['retry', 'requeue', 'again', 'failed'],
    destructive: true,
    outputSchema: RetryPostResponseSchema,
    buildRequest: (args) => ({
      method: 'POST',
      path: `/v1/posts/${String(args.post_id)}/retry`,
    }),
  },
  {
    name: 'register_media_url',
    description:
      'Register an image or video that already lives at a public URL, so it can be used in ' +
      'a post. For bytes you hold locally, use the REST upload flow — an MCP tool call is ' +
      'not a sensible place to move a 200 MB video.',
    inputSchema: z.object({
      profile_id: profileId,
      url: z.string().describe('Publicly reachable HTTPS URL of the media.'),
      alt_text: z.string().optional().describe('Accessibility description.'),
    }),
    scopes: ['media:write'],
    keywords: ['media', 'image', 'video', 'upload', 'attach', 'photo'],
    destructive: false,
    buildRequest: (args) => ({ method: 'POST', path: '/v1/media/external', body: args }),
  },
  {
    name: 'get_media',
    description: 'One media asset with its probed dimensions, duration, size and status.',
    inputSchema: z.object({ media_id: z.string().describe('Public media id, `med_…`.') }),
    scopes: ['media:read'],
    keywords: ['media', 'asset', 'dimensions', 'status'],
    destructive: false,
    outputSchema: MediaSchema,
    buildRequest: (args) => ({ method: 'GET', path: `/v1/media/${String(args.media_id)}` }),
  },
  {
    name: 'get_provider_status',
    description:
      'Recent success rates per platform in this environment. Use it to tell "this platform ' +
      'is having a bad hour" apart from "this post is wrong", before advising anyone to ' +
      'change their content.',
    inputSchema: z.object({}),
    scopes: ['capabilities:read'],
    keywords: ['status', 'health', 'outage', 'provider', 'platform', 'incident'],
    destructive: false,
    outputSchema: ProviderHealthResponseSchema,
    buildRequest: () => ({ method: 'GET', path: '/v1/provider-health' }),
  },
  {
    name: 'list_webhook_endpoints',
    description:
      'The webhook endpoints configured for this environment, with their health. Start here ' +
      'before asking about deliveries — deliveries are scoped to an endpoint.',
    inputSchema: z.object({}),
    scopes: ['webhooks:manage'],
    keywords: ['webhook', 'endpoint', 'subscription', 'callback'],
    destructive: false,
    outputSchema: WebhookEndpointListResponseSchema,
    buildRequest: () => ({ method: 'GET', path: '/v1/webhooks' }),
  },
  {
    name: 'list_webhook_deliveries',
    description:
      'Recent delivery attempts for one webhook endpoint, with response codes — the tool ' +
      'for "did the customer’s endpoint actually receive the event?". Get the endpoint id ' +
      'from list_webhook_endpoints.',
    inputSchema: z.object({
      webhook_id: z.string().describe('Public webhook endpoint id, `wh_…`.'),
      ...PaginationArgs,
    }),
    scopes: ['webhooks:manage'],
    keywords: ['webhook', 'delivery', 'event', 'callback', 'notification', 'retry'],
    destructive: false,
    outputSchema: WebhookDeliveryListResponseSchema,
    buildRequest: (args) => ({
      method: 'GET',
      path: `/v1/webhooks/${String(args.webhook_id)}/deliveries`,
      query: { limit: str(args.limit), cursor: str(args.cursor) },
    }),
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(
  MCP_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * `search_tools`, described in the tool list itself.
 *
 * Handled by the dispatcher rather than the table because it is the one tool whose
 * implementation is the table. Plan §50 pairs a small default set with discovery precisely
 * so the default set can stay small.
 */
export const SEARCH_TOOL: McpTool = {
  name: 'search_tools',
  description:
    'Find tools by topic when the one you need is not in the default set — for example ' +
    '"instagram comments", "analytics" or "webhooks". Returns matching tool names and ' +
    'descriptions.',
  inputSchema: z.object({ query: z.string().describe('What you are trying to do.') }),
  scopes: [],
  keywords: ['search', 'find', 'discover', 'tools', 'help'],
  destructive: false,
  buildRequest: () => {
    throw new Error('search_tools is handled by the dispatcher.');
  },
};

/** Rank tools against a free-text query. Exact name match first, then keyword, then prose. */
export function searchTools(query: string): McpTool[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...MCP_TOOLS];

  const scored = MCP_TOOLS.map((tool) => {
    let score = 0;
    const haystack = `${tool.name} ${tool.description}`.toLowerCase();

    for (const term of terms) {
      if (tool.name.toLowerCase().includes(term)) score += 5;
      if (tool.keywords.some((keyword) => keyword.includes(term))) score += 3;
      if (haystack.includes(term)) score += 1;
    }

    return { tool, score };
  }).filter((entry) => entry.score > 0);

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.tool);
}

// ---------------------------------------------------------------------------

/**
 * Tool argument schemas reuse the REST request schemas rather than restating them.
 *
 * A hand-written copy would drift the first time a field is added, and an agent calling a
 * tool whose schema is a stale copy of the route's gets a validation error it cannot act
 * on — the schema said the call was correct.
 */
function postArgs(): z.ZodType {
  return CreatePostRequestSchema.extend({
    idempotency_key: z
      .string()
      .optional()
      .describe(
        'Reuse the same key to retry safely without publishing twice. One is generated if ' +
          'you omit it, which protects against a dropped response but not against a retry ' +
          'you issue yourself.',
      ),
  });
}

function composeArgs(): z.ZodType {
  return ComposeRequestSchema;
}

/** Present for symmetry with `postArgs`; preflight takes the same body by design. */
export const PREFLIGHT_ARGS = PreflightRequestSchema;

function str(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}
