import {
  ApiKeyListResponseSchema,
  CapabilitiesResponseSchema,
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  EnvironmentListResponseSchema,
  RevokeApiKeyResponseSchema,
  CompleteMediaUploadResponseSchema,
  ConnectionListResponseSchema,
  CreateExternalMediaRequestSchema,
  CreateMediaUploadRequestSchema,
  CreateMediaUploadResponseSchema,
  DeleteMediaResponseSchema,
  CancelPostResponseSchema,
  CreatePostRequestSchema,
  ListPostsQuerySchema,
  MediaSchema,
  PostListResponseSchema,
  PostSchema,
  PreflightRequestSchema,
  PreflightResponseSchema,
  CreateWebhookEndpointRequestSchema,
  CreateWebhookEndpointResponseSchema,
  DeleteWebhookEndpointResponseSchema,
  ListWebhookDeliveriesQuerySchema,
  ReplayWebhookDeliveryResponseSchema,
  RetryPostResponseSchema,
  RotateWebhookSecretResponseSchema,
  TestWebhookResponseSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryListResponseSchema,
  WebhookEndpointListResponseSchema,
  WebhookEndpointSchema,
  ConnectionSchema,
  CreateProfileRequestSchema,
  DeleteProfileResponseSchema,
  DestinationListResponseSchema,
  DisconnectConnectionResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ListConnectionsQuerySchema,
  ListProfilesQuerySchema,
  MeResponseSchema,
  PlatformListResponseSchema,
  ProfileListResponseSchema,
  ProfileSchema,
  UpdateProfileRequestSchema,
} from '@gs/contracts/http';
import { PaginationQuerySchema } from '@gs/contracts/pagination';
import { API_SCOPES, type ApiScope } from '@gs/contracts/scopes';
import { ERROR_CODE_METADATA, type ErrorCode } from '@gs/errors';
import { z } from 'zod';

/**
 * OpenAPI document, generated from the same Zod schemas the routes validate with
 * (plan §85 Rule 5, §46 "OpenAPI is a product artifact").
 *
 * Generating rather than hand-writing is the point: a schema and its documentation cannot
 * drift when there is only one of them. The route table below is declarative for the same
 * reason — a hand-maintained `paths` object silently omits routes, and an omitted route is
 * an undocumented one.
 *
 * Zod v4 emits JSON Schema natively, so no extra OpenAPI dependency is pulled in.
 */

const SPEC_VERSION = '3.1.0';

/**
 * `io: 'output'` matters: a schema with defaults or transforms has a wider input type than
 * output type, and a response body is the output side. Using the input projection would
 * document optional fields that responses always populate.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'output'): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
  // OpenAPI supplies its own $schema; leaving Zod's in makes some tooling complain.
  delete (generated as Record<string, unknown>).$schema;
  return generated as Record<string, unknown>;
}

/**
 * Error responses, built from the catalog in `@gs/errors` (Rule 5: documented error
 * codes). The catalog is the single source, so a documented code cannot drift from the
 * one the route actually throws.
 */
function errorResponses(codes: readonly ErrorCode[]): Record<string, unknown> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const { status } = ERROR_CODE_METADATA[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  return Object.fromEntries(
    [...byStatus.entries()]
      .sort(([a], [b]) => a - b)
      .map(([status, group]) => [
        String(status),
        {
          description: group
            .map((code) => `\`${code}\` — ${ERROR_CODE_METADATA[code].message}`)
            .join('\n\n'),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      ]),
  );
}

/** Errors every authenticated route can return. Restating them per route invites omission. */
const AUTH_ERRORS = [
  'AUTHENTICATION_REQUIRED',
  'API_KEY_MALFORMED',
  'API_KEY_INVALID',
  'API_KEY_REVOKED',
  'API_KEY_EXPIRED',
  'INSUFFICIENT_SCOPE',
  'TENANT_FORBIDDEN',
  'INTERNAL_ERROR',
] as const satisfies readonly ErrorCode[];

interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  /** Omit for public routes. Scopes are documented, not just required. */
  scopes?: readonly ApiScope[];
  requestBody?: z.ZodType;
  querySchema?: z.ZodType;
  pathParams?: { name: string; description: string }[];
  successStatus: number;
  successDescription: string;
  response: z.ZodType;
  errors: readonly ErrorCode[];
}

/**
 * Query parameters, derived from the same Zod schema the route parses with. Hand-listing
 * them is how a `limit` cap ends up documented as 1000 while the code enforces 100.
 */
function queryParameters(schema: z.ZodType): Record<string, unknown>[] {
  const generated = jsonSchema(schema, 'input') as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };

  return Object.entries(generated.properties ?? {}).map(([name, definition]) => ({
    name,
    in: 'query',
    required: generated.required?.includes(name) ?? false,
    schema: definition,
    ...(definition.description ? { description: definition.description } : {}),
  }));
}

function buildOperation(route: RouteSpec): Record<string, unknown> {
  const parameters = [
    ...(route.pathParams ?? []).map((param) => ({
      name: param.name,
      in: 'path',
      required: true,
      description: param.description,
      schema: { type: 'string' },
    })),
    ...(route.querySchema ? queryParameters(route.querySchema) : []),
  ];

  return {
    operationId: route.operationId,
    summary: route.summary,
    description: route.scopes
      ? `${route.description}\n\nRequires scope: ${route.scopes.map((s) => `\`${s}\``).join(', ') || 'none beyond a valid key'}.`
      : route.description,
    tags: route.tags,
    security: route.scopes === undefined ? [] : [{ apiKey: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.requestBody
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(route.requestBody, 'input') } },
          },
        }
      : {}),
    responses: {
      [String(route.successStatus)]: {
        description: route.successDescription,
        headers: {
          'x-request-id': {
            description: 'Echoed request identifier. Quote this when reporting a problem.',
            schema: { type: 'string' },
          },
          'x-trace-id': {
            description: 'Trace identifier correlating this request across services.',
            schema: { type: 'string' },
          },
        },
        content: { 'application/json': { schema: jsonSchema(route.response) } },
      },
      ...errorResponses(route.errors),
    },
  };
}

const PROFILE_ID_PARAM = [
  { name: 'profileId', description: 'Public profile id, `pro_…`.' },
];

const ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness probe',
    description:
      'Returns 200 whenever the Worker can serve requests. Unauthenticated, and returns ' +
      'no tenant data. Does not check database connectivity — a database blip should not ' +
      'make the platform recycle a Worker that can still serve cached and queue-bound work.',
    tags: ['Operations'],
    successStatus: 200,
    successDescription: 'The Worker is serving requests.',
    response: HealthResponseSchema,
    errors: ['INTERNAL_ERROR'],
  },
  {
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'Describe the presenting API key',
    description:
      'Returns the tenant and scopes the presented key resolves to. Requires a valid key ' +
      'but no particular scope — a key may always describe itself, and requiring a scope ' +
      'would stop a misconfigured key from discovering why it is misconfigured.',
    tags: ['Identity'],
    scopes: [],
    successStatus: 200,
    successDescription: 'The key is valid.',
    response: MeResponseSchema,
    errors: AUTH_ERRORS,
  },
  {
    method: 'post',
    path: '/v1/profiles',
    operationId: 'createProfile',
    summary: 'Create a profile',
    description:
      'A profile is the white-label tenant primitive — your customer, brand, location or ' +
      'creator identity. Everything publishable hangs off one. Supplying `external_id` is ' +
      'recommended: it makes creation naturally idempotent from your side, because a ' +
      'repeat conflicts rather than silently creating a duplicate customer.',
    tags: ['Profiles'],
    scopes: ['profiles:write'],
    requestBody: CreateProfileRequestSchema,
    successStatus: 201,
    successDescription: 'The profile was created.',
    response: ProfileSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'RESOURCE_ALREADY_EXISTS'],
  },
  {
    method: 'get',
    path: '/v1/profiles',
    operationId: 'listProfiles',
    summary: 'List profiles',
    description:
      'Cursor-paginated, newest first. The cursor is the last id on the previous page, so ' +
      'a row inserted mid-pagination cannot shift a page boundary and make you skip or ' +
      'repeat an item — which offset pagination over an actively-written table does.',
    tags: ['Profiles'],
    scopes: ['profiles:read'],
    querySchema: ListProfilesQuerySchema,
    successStatus: 200,
    successDescription: 'A page of profiles.',
    response: ProfileListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST'],
  },
  {
    method: 'get',
    path: '/v1/profiles/{profileId}',
    operationId: 'getProfile',
    summary: 'Retrieve a profile',
    description: 'Returns 404 for a profile belonging to another tenant.',
    tags: ['Profiles'],
    scopes: ['profiles:read'],
    pathParams: PROFILE_ID_PARAM,
    successStatus: 200,
    successDescription: 'The profile.',
    response: ProfileSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'PROFILE_NOT_FOUND'],
  },
  {
    method: 'patch',
    path: '/v1/profiles/{profileId}',
    operationId: 'updateProfile',
    summary: 'Update a profile',
    description:
      'An absent key leaves the field unchanged; an explicit `null` clears it. The two are ' +
      'genuinely different, and conflating them would make clearing a field impossible.',
    tags: ['Profiles'],
    scopes: ['profiles:write'],
    pathParams: PROFILE_ID_PARAM,
    requestBody: UpdateProfileRequestSchema,
    successStatus: 200,
    successDescription: 'The updated profile.',
    response: ProfileSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'PROFILE_NOT_FOUND', 'RESOURCE_ALREADY_EXISTS'],
  },
  {
    method: 'delete',
    path: '/v1/profiles/{profileId}',
    operationId: 'deleteProfile',
    summary: 'Delete a profile',
    description:
      'Soft delete. The row is retained for the deletion window so in-flight publishes can ' +
      'still resolve their tenancy chain; a hard delete would strand queued targets with an ' +
      'unresolvable owner.',
    tags: ['Profiles'],
    scopes: ['profiles:write'],
    pathParams: PROFILE_ID_PARAM,
    successStatus: 200,
    successDescription: 'The profile was deleted.',
    response: DeleteProfileResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'PROFILE_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/v1/connections',
    operationId: 'listConnections',
    summary: 'List connections',
    description:
      'A connection is one authorization relationship with a provider. It is a live thing ' +
      'that degrades — check `health` before assuming it can publish. Disconnected ' +
      'connections are excluded unless `include_disconnected` is set.',
    tags: ['Connections'],
    scopes: ['connections:read'],
    querySchema: ListConnectionsQuerySchema,
    successStatus: 200,
    successDescription: 'A page of connections.',
    response: ConnectionListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST'],
  },
  {
    method: 'get',
    path: '/v1/connections/{connectionId}',
    operationId: 'getConnection',
    summary: 'Retrieve a connection',
    description:
      'Never returns credential material — not the token, not its ciphertext. `health` and ' +
      '`granted_scopes` are the observable surface, and they explain any failure you will see.',
    tags: ['Connections'],
    scopes: ['connections:read'],
    pathParams: [{ name: 'connectionId', description: 'Public connection id, `con_…`.' }],
    successStatus: 200,
    successDescription: 'The connection.',
    response: ConnectionSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'CONNECTION_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/v1/connections/{connectionId}/destinations',
    operationId: 'listConnectionDestinations',
    summary: 'List a connection’s destinations',
    description:
      'A destination is an actual publishable surface: a Page, an organization, a board, a ' +
      'channel. One connection commonly yields several, which is why they are separate ' +
      'objects. Only `selected` destinations can be published to.',
    tags: ['Connections'],
    scopes: ['destinations:read'],
    pathParams: [{ name: 'connectionId', description: 'Public connection id, `con_…`.' }],
    successStatus: 200,
    successDescription: 'The connection’s destinations.',
    response: DestinationListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'CONNECTION_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/connections/{connectionId}/disconnect',
    operationId: 'disconnectConnection',
    summary: 'Disconnect a connection',
    description:
      'Idempotent: disconnecting an already-disconnected connection succeeds. Soft, so a ' +
      'later reconnect of the same provider account updates cleanly rather than creating a ' +
      'duplicate that would double-post.',
    tags: ['Connections'],
    scopes: ['connections:write'],
    pathParams: [{ name: 'connectionId', description: 'Public connection id, `con_…`.' }],
    successStatus: 200,
    successDescription: 'The connection is disconnected.',
    response: DisconnectConnectionResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'CONNECTION_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/v1/platforms',
    operationId: 'listPlatforms',
    summary: 'List supported platforms',
    description:
      'Every provider the product targets. `available: false` means the adapter is not built ' +
      'yet — listed so a UI can render it from the API rather than hard-coding a second list ' +
      'that drifts.',
    tags: ['Capabilities'],
    scopes: ['capabilities:read'],
    successStatus: 200,
    successDescription: 'The platform list.',
    response: PlatformListResponseSchema,
    errors: AUTH_ERRORS,
  },
  {
    method: 'get',
    path: '/v1/platforms/{provider}/capabilities',
    operationId: 'getPlatformCapabilities',
    summary: 'Generic platform capabilities',
    description:
      'What the platform can do at all. Account-specific narrowing is deliberately absent — ' +
      'for what a particular connected account can do, call the destination capabilities ' +
      'endpoint, which accounts for granted scopes, account type and platform approval state.',
    tags: ['Capabilities'],
    scopes: ['capabilities:read'],
    pathParams: [{ name: 'provider', description: 'Provider identifier, e.g. `bluesky`.' }],
    successStatus: 200,
    successDescription: 'Generic capabilities for the platform.',
    response: CapabilitiesResponseSchema,
    errors: [...AUTH_ERRORS, 'PROVIDER_NOT_SUPPORTED'],
  },
  {
    method: 'get',
    path: '/v1/destinations/{destinationId}/capabilities',
    operationId: 'getDestinationCapabilities',
    summary: 'Effective capabilities for a destination',
    description:
      'What THIS destination can actually do, narrowed by granted scopes, account type, ' +
      'subscription, platform approval and rollout. Every capability that is unavailable ' +
      'carries a `restrictions` entry explaining why and what would lift it — `video: false` ' +
      'alone cannot distinguish "unsupported" from "missing a scope", and the fix differs.',
    tags: ['Capabilities'],
    scopes: ['capabilities:read'],
    pathParams: [{ name: 'destinationId', description: 'Public destination id, `dst_…`.' }],
    successStatus: 200,
    successDescription: 'Effective capabilities for the destination.',
    response: CapabilitiesResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'DESTINATION_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/media/uploads',
    operationId: 'createMediaUpload',
    summary: 'Start a media upload',
    description:
      'Returns a presigned URL. PUT the bytes straight to it, then call the complete ' +
      'endpoint. The bytes never pass through the API — a large video would exceed both the ' +
      'request-size limit and the CPU budget. The declared content type and length are ' +
      'signed into the URL, so it cannot be reused to upload something else.',
    tags: ['Media'],
    scopes: ['media:write'],
    requestBody: CreateMediaUploadRequestSchema,
    successStatus: 201,
    successDescription: 'Presigned upload details.',
    response: CreateMediaUploadResponseSchema,
    errors: [
      ...AUTH_ERRORS,
      'INVALID_REQUEST',
      'PROFILE_NOT_FOUND',
      'MEDIA_TYPE_UNSUPPORTED',
      'MEDIA_TOO_LARGE',
    ],
  },
  {
    method: 'post',
    path: '/v1/media/uploads/{mediaId}/complete',
    operationId: 'completeMediaUpload',
    summary: 'Complete a media upload',
    description:
      'Confirms the bytes are in place and queues the metadata probe. The asset is not ' +
      'ready until probing finishes: until then the only thing known about the file is what ' +
      'the client claimed, and validating against a claim would approve posts the provider ' +
      'then rejects. Safe to call twice.',
    tags: ['Media'],
    scopes: ['media:write'],
    pathParams: [{ name: 'mediaId', description: 'Public media id, `med_…`.' }],
    successStatus: 200,
    successDescription: 'The media asset.',
    response: CompleteMediaUploadResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'MEDIA_NOT_FOUND', 'CONFLICTING_STATE'],
  },
  {
    method: 'post',
    path: '/v1/media/external',
    operationId: 'createExternalMedia',
    summary: 'Register externally hosted media',
    description:
      'Registers a URL you already host. It is validated against SSRF rules before anything ' +
      'fetches it — private, loopback, link-local and cloud-metadata addresses are refused, ' +
      'including the IPv4-mapped IPv6 spellings of them.',
    tags: ['Media'],
    scopes: ['media:write'],
    requestBody: CreateExternalMediaRequestSchema,
    successStatus: 201,
    successDescription: 'The media asset.',
    response: MediaSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'PROFILE_NOT_FOUND', 'MEDIA_URL_NOT_ALLOWED'],
  },
  {
    method: 'get',
    path: '/v1/media/{mediaId}',
    operationId: 'getMedia',
    summary: 'Retrieve a media asset',
    description: 'Poll until `status` is `ready` before attaching the asset to a post.',
    tags: ['Media'],
    scopes: ['media:read'],
    pathParams: [{ name: 'mediaId', description: 'Public media id, `med_…`.' }],
    successStatus: 200,
    successDescription: 'The media asset.',
    response: MediaSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'MEDIA_NOT_FOUND'],
  },
  {
    method: 'delete',
    path: '/v1/media/{mediaId}',
    operationId: 'deleteMedia',
    summary: 'Delete a media asset',
    description:
      'Soft delete. A published post’s timeline still references the asset, and the stored ' +
      'object is reaped separately once nothing in flight can need it.',
    tags: ['Media'],
    scopes: ['media:write'],
    pathParams: [{ name: 'mediaId', description: 'Public media id, `med_…`.' }],
    successStatus: 200,
    successDescription: 'The asset was deleted.',
    response: DeleteMediaResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'MEDIA_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/posts/preflight',
    operationId: 'preflightPost',
    summary: 'Validate a post without publishing',
    description:
      'Takes exactly the same body as POST /v1/posts, so you can check precisely what you ' +
      'are about to send. Performs no provider side effect and is safe to call freely. ' +
      'Returns 200 even when invalid — reporting problems is the job, and a 4xx would make ' +
      '"your content has a warning" look like "your request was malformed". Findings carry ' +
      'an agent_action and, where one exists, a concrete autofix.',
    tags: ['Publishing'],
    scopes: ['posts:read'],
    requestBody: PreflightRequestSchema,
    successStatus: 200,
    successDescription: 'Per-target validation results.',
    response: PreflightResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'PROFILE_NOT_FOUND', 'DUPLICATE_DESTINATION'],
  },
  {
    method: 'post',
    path: '/v1/posts',
    operationId: 'createPost',
    summary: 'Publish a post',
    description:
      'Returns **202**, always. Publishing is asynchronous and must never depend on your ' +
      'client holding a connection open. Watch target status or subscribe to a webhook.\n\n' +
      'An `Idempotency-Key` header is **required**: a duplicate published post cannot be ' +
      'undone, so retrying safely needs something to deduplicate on. A repeat with the same ' +
      'key replays the original response byte-for-byte; the same key with a different body ' +
      'is a 409.\n\n' +
      'One logical post, N targets. Per-target `overrides` replace canonical content rather ' +
      'than merging — an override of `media_ids: []` means "publish this one without media".',
    tags: ['Publishing'],
    scopes: ['posts:write'],
    requestBody: CreatePostRequestSchema,
    successStatus: 202,
    successDescription: 'The post was accepted and queued.',
    response: PostSchema,
    errors: [
      ...AUTH_ERRORS,
      'INVALID_REQUEST',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      'VALIDATION_FAILED',
      'PROFILE_NOT_FOUND',
      'DUPLICATE_DESTINATION',
    ],
  },
  {
    method: 'get',
    path: '/v1/posts',
    operationId: 'listPosts',
    summary: 'List posts',
    description:
      'Omits per-target detail — a page of 25 posts each with 10 targets is a response ' +
      'nobody reads in full. Rolled-up counts are enough for a list view; fetch a post for ' +
      'the rest.',
    tags: ['Publishing'],
    scopes: ['posts:read'],
    querySchema: ListPostsQuerySchema,
    successStatus: 200,
    successDescription: 'A page of posts.',
    response: PostListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST'],
  },
  {
    method: 'get',
    path: '/v1/posts/{postId}',
    operationId: 'getPost',
    summary: 'Retrieve a post',
    description:
      'Includes every target with its current status. `partially_published` is a real ' +
      'outcome, not an error: some destinations succeeded and some did not, and each target ' +
      'carries its own normalized error code.',
    tags: ['Publishing'],
    scopes: ['posts:read'],
    pathParams: [{ name: 'postId', description: 'Public post id, `pst_…`.' }],
    successStatus: 200,
    successDescription: 'The post and its targets.',
    response: PostSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'POST_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/posts/{postId}/cancel',
    operationId: 'cancelPost',
    summary: 'Cancel a post',
    description:
      'Cancels every target not already published or in flight. Targets that are ' +
      '`publishing` or `provider_processing` are deliberately left alone: a call may already ' +
      'be at the provider, and marking it cancelled would claim an outcome we do not control.',
    tags: ['Publishing'],
    scopes: ['posts:write'],
    pathParams: [{ name: 'postId', description: 'Public post id, `pst_…`.' }],
    successStatus: 200,
    successDescription: 'How many targets were cancelled.',
    response: CancelPostResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'POST_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/posts/{postId}/retry',
    operationId: 'retryPost',
    summary: 'Retry failed targets',
    description:
      'Requeues only `retryable_failed` targets. A `permanent_failed` target fails the same ' +
      'way again, and one in `unknown_reconciliation_required` must be reconciled first — ' +
      'retrying it could duplicate a post that did in fact publish.',
    tags: ['Publishing'],
    scopes: ['posts:write'],
    pathParams: [{ name: 'postId', description: 'Public post id, `pst_…`.' }],
    successStatus: 202,
    successDescription: 'How many targets were requeued.',
    response: RetryPostResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'POST_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/webhooks',
    operationId: 'createWebhookEndpoint',
    summary: 'Register a webhook endpoint',
    description:
      'Delivery is **at least once**. Every event keeps one stable `event_id` across all ' +
      'its attempts — deduplicate on it.\n\n' +
      'The signing secret is returned exactly once here and at rotation. It is derived ' +
      'from a root held outside the database rather than stored, so it genuinely cannot be ' +
      'retrieved again.\n\n' +
      'An empty `event_types` subscribes to everything, which is the useful default for a ' +
      'first integration. HTTPS only: the body carries tenant data and is signed but not ' +
      'encrypted.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    requestBody: CreateWebhookEndpointRequestSchema,
    successStatus: 201,
    successDescription: 'The endpoint and its signing secret.',
    response: CreateWebhookEndpointResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST'],
  },
  {
    method: 'get',
    path: '/v1/webhooks',
    operationId: 'listWebhookEndpoints',
    summary: 'List webhook endpoints',
    description:
      'An endpoint in `auto_disabled` was disabled by us after sustained failure, so a dead ' +
      'endpoint stops burning retries. Re-enable it with a PATCH once it is fixed.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    querySchema: PaginationQuerySchema,
    successStatus: 200,
    successDescription: 'A page of endpoints.',
    response: WebhookEndpointListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST'],
  },
  {
    method: 'get',
    path: '/v1/webhooks/{webhookId}',
    operationId: 'getWebhookEndpoint',
    summary: 'Retrieve a webhook endpoint',
    description: 'Never returns the signing secret; it is only shown at creation and rotation.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    successStatus: 200,
    successDescription: 'The endpoint.',
    response: WebhookEndpointSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND'],
  },
  {
    method: 'patch',
    path: '/v1/webhooks/{webhookId}',
    operationId: 'updateWebhookEndpoint',
    summary: 'Update a webhook endpoint',
    description:
      '`event_types` replaces the whole set rather than merging — merging would make ' +
      'removing a subscription impossible. Setting `enabled: true` also clears the ' +
      'consecutive-failure counter, so a fixed endpoint is not re-disabled on its next hiccup.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    requestBody: UpdateWebhookEndpointRequestSchema,
    successStatus: 200,
    successDescription: 'The updated endpoint.',
    response: WebhookEndpointSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND'],
  },
  {
    method: 'delete',
    path: '/v1/webhooks/{webhookId}',
    operationId: 'deleteWebhookEndpoint',
    summary: 'Delete a webhook endpoint',
    description:
      'Deliveries are removed with it. Unlike other resources this is a hard delete: an ' +
      'endpoint you removed should stop receiving traffic immediately, not linger where a ' +
      'sweeper might still pick it up.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    successStatus: 200,
    successDescription: 'The endpoint was deleted.',
    response: DeleteWebhookEndpointResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/webhooks/{webhookId}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret',
    description:
      'Returns a new secret and keeps the previous one verifying until ' +
      '`previous_secret_valid_until`, so you can deploy the new one without dropping ' +
      'deliveries in the gap.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    successStatus: 200,
    successDescription: 'The new secret and the overlap window.',
    response: RotateWebhookSecretResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/v1/webhooks/{webhookId}/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'List delivery attempts',
    description:
      'Each row carries the HTTP status, duration, attempt count, next retry and a scrubbed ' +
      'excerpt of your endpoint’s response — enough to debug a failing integration without ' +
      'reading our logs.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    querySchema: ListWebhookDeliveriesQuerySchema,
    successStatus: 200,
    successDescription: 'A page of deliveries.',
    response: WebhookDeliveryListResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/v1/webhooks/{webhookId}/test',
    operationId: 'testWebhookEndpoint',
    summary: 'Send a test event',
    description:
      'Sends a synthetic event through the real delivery path, so what you wire up against ' +
      'is exactly what production sends. A special-cased test payload would let the real ' +
      'path stay broken while the test one worked.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'webhookId', description: 'Public endpoint id, `wh_…`.' }],
    successStatus: 202,
    successDescription: 'The test delivery was queued.',
    response: TestWebhookResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'WEBHOOK_NOT_FOUND', 'CONFLICTING_STATE'],
  },
  {
    method: 'post',
    path: '/v1/webhook-deliveries/{deliveryId}/replay',
    operationId: 'replayWebhookDelivery',
    summary: 'Replay a delivery',
    description:
      'Queues a fresh delivery of the same event. The original attempt is preserved as the ' +
      'historical record rather than reset — a conversation about why something failed ' +
      'needs the failure to still exist.',
    tags: ['Webhooks'],
    scopes: ['webhooks:manage'],
    pathParams: [{ name: 'deliveryId', description: 'Public delivery id, `whd_…`.' }],
    successStatus: 202,
    successDescription: 'The replay was queued.',
    response: ReplayWebhookDeliveryResponseSchema,
    errors: [...AUTH_ERRORS, 'INVALID_REQUEST', 'DELIVERY_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/v1/environments',
    operationId: 'listEnvironments',
    summary: 'List environments you can access',
    description:
      '**Requires a signed-in dashboard session, not an API key.** Returns every ' +
      'test and live environment your user is a member of, with your role in each.',
    tags: ['Administration'],
    scopes: [],
    successStatus: 200,
    successDescription: 'Environments you belong to.',
    response: EnvironmentListResponseSchema,
    errors: ['AUTHENTICATION_REQUIRED', 'INTERNAL_ERROR'],
  },
  {
    method: 'post',
    path: '/v1/api-keys',
    operationId: 'createApiKey',
    summary: 'Create an API key',
    description:
      '**Requires a signed-in dashboard session, not an API key.** A key cannot mint ' +
      'another key: that would turn one leaked credential into permanent self-renewing ' +
      'access that revoking the original does not stop.\n\n' +
      'The key value is returned exactly once. Keys are stored hashed under a pepper, so ' +
      'it is genuinely unrecoverable afterwards rather than merely hidden.\n\n' +
      '`scopes` has no default — least privilege only works if stating the purpose is the ' +
      'easy path. The environment decides the `sk_test_` / `sk_live_` prefix, not you.',
    tags: ['Administration'],
    scopes: [],
    requestBody: CreateApiKeyRequestSchema,
    successStatus: 201,
    successDescription: 'The key, shown once.',
    response: CreateApiKeyResponseSchema,
    errors: ['AUTHENTICATION_REQUIRED', 'TENANT_FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR'],
  },
  {
    method: 'get',
    path: '/v1/api-keys',
    operationId: 'listApiKeys',
    summary: 'List API keys',
    description:
      '**Requires a signed-in dashboard session.** Returns each key’s searchable prefix, ' +
      'never the key itself. Pass `environment_id` as a query parameter.',
    tags: ['Administration'],
    scopes: [],
    successStatus: 200,
    successDescription: 'Keys in the environment.',
    response: ApiKeyListResponseSchema,
    errors: ['AUTHENTICATION_REQUIRED', 'TENANT_FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR'],
  },
  {
    method: 'post',
    path: '/v1/api-keys/{keyId}/revoke',
    operationId: 'revokeApiKey',
    summary: 'Revoke an API key',
    description:
      '**Requires a signed-in dashboard session.** Takes effect immediately: authentication ' +
      'reads the key’s status on every request, so the next call with it fails. There is no ' +
      'undo. Pass `environment_id` as a query parameter.',
    tags: ['Administration'],
    scopes: [],
    pathParams: [{ name: 'keyId', description: 'Public key id, `key_…`.' }],
    successStatus: 200,
    successDescription: 'The key is revoked.',
    response: RevokeApiKeyResponseSchema,
    errors: [
      'AUTHENTICATION_REQUIRED',
      'TENANT_FORBIDDEN',
      'INVALID_REQUEST',
      'RESOURCE_NOT_FOUND',
      'INTERNAL_ERROR',
    ],
  },
];

export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    paths[route.path] = { ...paths[route.path], [route.method]: buildOperation(route) };
  }

  return {
    openapi: SPEC_VERSION,
    info: {
      title: 'GainingSocial Unified Social API',
      version: '0.1.0',
      description:
        'Social execution infrastructure for software and AI agents. ' +
        'All timestamps are UTC ISO-8601. All resource ids are prefixed and opaque.',
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: { Error: jsonSchema(ErrorEnvelopeSchema) },
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Project-scoped API key, `sk_live_…` or `sk_test_…`, sent as a bearer token. ' +
            'The key determines the tenant and environment; neither can be named by the ' +
            'caller.',
        },
      },
    },
    'x-scopes': API_SCOPES,
  };
}
