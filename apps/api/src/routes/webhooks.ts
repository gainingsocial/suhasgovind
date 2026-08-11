import {
  CreateWebhookEndpointRequestSchema,
  CreateWebhookEndpointResponseSchema,
  DeleteWebhookEndpointResponseSchema,
  ListWebhookDeliveriesQuerySchema,
  ReplayWebhookDeliveryResponseSchema,
  RotateWebhookSecretResponseSchema,
  TestWebhookResponseSchema,
  UpdateWebhookEndpointRequestSchema,
  WebhookDeliveryListResponseSchema,
  WebhookDeliverySchema,
  WebhookEndpointListResponseSchema,
  WebhookEndpointSchema,
  WebhookEventTypeSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { PaginationQuerySchema } from '@gs/contracts/pagination';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  emitWebhookEvent,
  findWebhookDeliveryById,
  findWebhookEndpointById,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  type DeliveryWithEvent,
  type EndpointWithSubscriptions,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { CURRENT_WEBHOOK_API_VERSION } from '@gs/events';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { deriveWebhookSecret, PREVIOUS_SECRET_OVERLAP_MS } from '../services/webhook-secrets.js';
import { parseBody, parseQuery, requirePathId } from '../lib/request.js';

/**
 * Customer webhooks (plan P8, §35, §36).
 *
 * A product surface, not an afterthought. Plan P8 puts it alongside the API itself,
 * because an integrator who cannot find out that a post published has to poll — and
 * polling a publishing API is how rate limits get exhausted.
 */
export const webhooks = new Hono<AppEnv>();
export const webhookDeliveriesRoute = new Hono<AppEnv>();

function toEndpointResponse(row: EndpointWithSubscriptions) {
  return WebhookEndpointSchema.parse({
    id: toPublicId('webhookEndpoint', row.id),
    object: 'webhook_endpoint',
    url: row.url,
    description: row.description,
    status: row.status,
    event_types: row.eventTypes,
    profile_id: row.profileId ? toPublicId('profile', row.profileId) : null,
    api_version: row.apiVersion,
    secret_version: row.secretVersion,
    consecutive_failures: row.consecutiveFailures,
    // Rule 15 — UTC ISO-8601 throughout.
    last_success_at: row.lastSuccessAt?.toISOString() ?? null,
    last_failure_at: row.lastFailureAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toDeliveryResponse(row: DeliveryWithEvent) {
  return WebhookDeliverySchema.parse({
    id: toPublicId('webhookDelivery', row.id),
    object: 'webhook_delivery',
    webhook_endpoint_id: toPublicId('webhookEndpoint', row.webhookEndpointId),
    // Stable across every attempt for this event — the identifier a customer
    // deduplicates on, which is what makes at-least-once workable.
    event_id: toPublicId('event', row.eventPublicId),
    event_type: WebhookEventTypeSchema.parse(row.eventType),
    status: row.status,
    attempt_count: row.attemptCount,
    response_status: row.lastStatusCode,
    duration_ms: row.lastDurationMs,
    response_excerpt: row.lastResponseExcerpt,
    error_message: row.lastError,
    next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
    delivered_at: row.deliveredAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

async function loadOwnedEndpoint(
  c: Context<AppEnv>,
  endpointId: string,
): Promise<EndpointWithSubscriptions> {
  const principal = c.get('principal');
  const row = await findWebhookEndpointById(c.get('db'), principal.projectEnvironmentId, endpointId);
  if (!row) throw new ApiError('WEBHOOK_NOT_FOUND');

  if (
    principal.restrictedToProfileId !== null &&
    row.profileId !== null &&
    row.profileId !== principal.restrictedToProfileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return row;
}

webhooks.post('/', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateWebhookEndpointRequestSchema);

  let profileId: string | null = null;
  if (body.profile_id) {
    const resolved = fromPublicId('profile', body.profile_id);
    if (!resolved) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`profile_id` is not a valid profile id.',
        param: 'profile_id',
      });
    }
    profileId = resolved;
  }

  if (principal.restrictedToProfileId !== null) {
    // A restricted key may only create an endpoint scoped to its own profile — otherwise
    // it could subscribe to events for profiles it cannot otherwise see.
    if (profileId !== null && profileId !== principal.restrictedToProfileId) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'This API key is restricted to a different profile.',
      });
    }
    profileId = principal.restrictedToProfileId;
  }

  const created = await createWebhookEndpoint(c.get('db'), {
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    projectEnvironmentId: principal.projectEnvironmentId,
    url: body.url,
    description: body.description ?? null,
    eventTypes: body.event_types,
    profileId,
    apiVersion: CURRENT_WEBHOOK_API_VERSION,
  });

  // Derived from a root in Secrets Store rather than stored (ADR-007), so it genuinely
  // cannot be retrieved later — which is the correct property for a signing key, and the
  // reason rotation exists at all.
  const signingSecret = await deriveWebhookSecret(c.env, created.id, created.secretVersion);

  return c.json(
    CreateWebhookEndpointResponseSchema.parse({
      ...toEndpointResponse(created),
      signing_secret: signingSecret,
    }),
    201,
  );
});

webhooks.get('/', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, PaginationQuerySchema);

  const cursor = query.cursor ? fromPublicId('webhookEndpoint', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not a valid webhook id.' });
  }

  const { rows, hasMore } = await listWebhookEndpoints(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit,
    order: query.order,
    cursor: cursor ?? undefined,
  });

  const data = rows.map(toEndpointResponse);

  return c.json(
    WebhookEndpointListResponseSchema.parse({
      object: 'list',
      data,
      has_more: hasMore,
      next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    }),
    200,
  );
});

webhooks.get('/:webhookId', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');
  return c.json(toEndpointResponse(await loadOwnedEndpoint(c, webhookId)), 200);
});

webhooks.patch('/:webhookId', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const principal = c.get('principal');
  const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');
  const body = await parseBody(c, UpdateWebhookEndpointRequestSchema);

  await loadOwnedEndpoint(c, webhookId);

  const updated = await updateWebhookEndpoint(
    c.get('db'),
    principal.projectEnvironmentId,
    webhookId,
    {
      url: body.url,
      description: body.description,
      eventTypes: body.event_types,
      enabled: body.enabled,
    },
  );

  if (!updated) throw new ApiError('WEBHOOK_NOT_FOUND');
  return c.json(toEndpointResponse(updated), 200);
});

webhooks.delete('/:webhookId', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const principal = c.get('principal');
  const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');

  await loadOwnedEndpoint(c, webhookId);

  // A hard delete here, unlike everywhere else. Deliveries cascade, and an endpoint the
  // customer removed should stop receiving traffic immediately rather than lingering in
  // a soft-deleted state that a sweeper might still pick up.
  const deleted = await deleteWebhookEndpoint(c.get('db'), principal.projectEnvironmentId, webhookId);
  if (!deleted) throw new ApiError('WEBHOOK_NOT_FOUND');

  return c.json(
    DeleteWebhookEndpointResponseSchema.parse({
      id: toPublicId('webhookEndpoint', webhookId),
      object: 'webhook_endpoint',
      deleted: true,
    }),
    200,
  );
});

webhooks.post(
  '/:webhookId/rotate-secret',
  withDatabase(),
  authenticate(['webhooks:manage']),
  async (c) => {
    const principal = c.get('principal');
    const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');

    await loadOwnedEndpoint(c, webhookId);
    const version = await rotateWebhookSecret(c.get('db'), principal.projectEnvironmentId, webhookId);
    if (version === null) throw new ApiError('WEBHOOK_NOT_FOUND');

    const signingSecret = await deriveWebhookSecret(c.env, webhookId, version);

    return c.json(
      RotateWebhookSecretResponseSchema.parse({
        id: toPublicId('webhookEndpoint', webhookId),
        object: 'webhook_endpoint',
        secret_version: version,
        signing_secret: signingSecret,
        // The previous secret keeps verifying for a window, so a customer can deploy the
        // new one without dropping deliveries in the gap.
        previous_secret_valid_until: new Date(Date.now() + PREVIOUS_SECRET_OVERLAP_MS).toISOString(),
      }),
      200,
    );
  },
);

webhooks.get(
  '/:webhookId/deliveries',
  withDatabase(),
  authenticate(['webhooks:manage']),
  async (c) => {
    const principal = c.get('principal');
    const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');
    const query = parseQuery(c, ListWebhookDeliveriesQuerySchema);

    await loadOwnedEndpoint(c, webhookId);

    const cursor = query.cursor ? fromPublicId('webhookDelivery', query.cursor) : undefined;
    if (query.cursor && !cursor) {
      throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not a valid delivery id.' });
    }

    const { rows, hasMore } = await listWebhookDeliveries(c.get('db'), {
      projectEnvironmentId: principal.projectEnvironmentId,
      endpointId: webhookId,
      limit: query.limit,
      order: query.order,
      cursor: cursor ?? undefined,
      status: query.status,
      eventType: query.event_type,
    });

    const data = rows.map(toDeliveryResponse);

    return c.json(
      WebhookDeliveryListResponseSchema.parse({
        object: 'list',
        data,
        has_more: hasMore,
        next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      }),
      200,
    );
  },
);

webhooks.post('/:webhookId/test', withDatabase(), authenticate(['webhooks:manage']), async (c) => {
  const principal = c.get('principal');
  const trace = c.get('trace');
  const webhookId = requirePathId(c, 'webhookEndpoint', 'webhookId');

  const endpoint = await loadOwnedEndpoint(c, webhookId);

  // A synthetic event through the real delivery path, so what an integrator wires up
  // against is exactly what production sends. A special-cased test payload would let the
  // real path stay broken while the test one worked.
  const { eventId, deliveryIds } = await emitWebhookEvent(c.get('db'), {
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId: endpoint.profileId,
    eventType: 'post.published',
    apiVersion: endpoint.apiVersion,
    payload: {
      test: true,
      message: 'This is a test event from GainingSocial. No post was published.',
    },
    traceId: trace.traceId,
  });

  const deliveryId = deliveryIds[0];
  if (!deliveryId) {
    throw new ApiError('CONFLICTING_STATE', {
      message: 'The endpoint is disabled or does not subscribe to any event type.',
    });
  }

  if (c.env.WEBHOOK_QUEUE) {
    c.executionCtx.waitUntil(
      c.env.WEBHOOK_QUEUE.send({ type: 'webhook.deliver', deliveryId, traceId: trace.traceId }),
    );
  }

  return c.json(
    TestWebhookResponseSchema.parse({
      object: 'webhook_delivery',
      delivery_id: toPublicId('webhookDelivery', deliveryId),
      event_id: toPublicId('event', eventId),
      queued: true,
    }),
    202,
  );
});

webhookDeliveriesRoute.post(
  '/:deliveryId/replay',
  withDatabase(),
  authenticate(['webhooks:manage']),
  async (c) => {
    const principal = c.get('principal');
    const trace = c.get('trace');
    const deliveryId = requirePathId(c, 'webhookDelivery', 'deliveryId');

    const original = await findWebhookDeliveryById(
      c.get('db'),
      principal.projectEnvironmentId,
      deliveryId,
    );
    if (!original) throw new ApiError('DELIVERY_NOT_FOUND');

    // A new row, with the original preserved as the historical record — a support
    // conversation about why something failed needs the failure to still exist.
    const replayId = await replayWebhookDelivery(c.get('db'), original);

    if (c.env.WEBHOOK_QUEUE) {
      c.executionCtx.waitUntil(
        c.env.WEBHOOK_QUEUE.send({
          type: 'webhook.deliver',
          deliveryId: replayId,
          traceId: trace.traceId,
        }),
      );
    }

    return c.json(
      ReplayWebhookDeliveryResponseSchema.parse({
        object: 'webhook_delivery',
        delivery_id: toPublicId('webhookDelivery', replayId),
        event_id: toPublicId('event', original.eventPublicId),
        queued: true,
      }),
      202,
    );
  },
);
