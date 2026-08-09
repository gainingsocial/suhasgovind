import {
  ConnectionListResponseSchema,
  ConnectionSchema,
  DestinationListResponseSchema,
  DestinationSchema,
  DisconnectConnectionResponseSchema,
  ListConnectionsQuerySchema,
  type Connection as ConnectionResponse,
  type Destination as DestinationResponse,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  disconnectConnection,
  findConnectionById,
  listConnections,
  listDestinationsForConnection,
  type ConnectionWithScopes,
  type SocialDestination,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { parseQuery, requirePathId } from '../lib/request.js';

/**
 * Connections and their destinations (plan §8.5, §14).
 *
 * The authorize/callback half of the connect flow (plan §21) is not here: it needs the
 * provider app registry and the hosted connect UI, and it lives in `connect.ts`. What is
 * here is everything an integrator does with a connection once it exists.
 */
export const connections = new Hono<AppEnv>();

/**
 * A connection response deliberately carries no credential material — not the token, not
 * its ciphertext, not its expiry-derived secrets (P9, §7.2). Health and scopes are the
 * observable surface, and they are enough to explain any failure a caller will see.
 */
function toConnectionResponse(row: ConnectionWithScopes): ConnectionResponse {
  if (!isProviderName(row.provider)) {
    // A row naming a provider this build does not know is a data problem, not a caller
    // problem — surfacing it as a 500 with a precise message beats emitting an object
    // that fails its own output schema (Rule 14).
    throw new ApiError('INTERNAL_ERROR', {
      message: `Connection ${row.id} names unknown provider "${row.provider}".`,
    });
  }

  return ConnectionSchema.parse({
    id: toPublicId('connection', row.id),
    object: 'connection',
    profile_id: toPublicId('profile', row.profileId),
    provider: row.provider,
    auth_strategy: row.authStrategy,
    provider_account_id: row.providerAccountId,
    provider_account_name: row.providerAccountName,
    provider_account_handle: row.providerAccountHandle,
    provider_account_avatar_url: row.providerAccountAvatarUrl,
    health: row.health,
    health_detail: row.healthDetail,
    health_checked_at: row.healthCheckedAt?.toISOString() ?? null,
    setup_completed_at: row.setupCompletedAt?.toISOString() ?? null,
    granted_scopes: row.grantedScopes,
    connected_at: row.connectedAt.toISOString(),
    disconnected_at: row.disconnectedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
  });
}

function toDestinationResponse(row: SocialDestination): DestinationResponse {
  if (!isProviderName(row.provider)) {
    throw new ApiError('INTERNAL_ERROR', {
      message: `Destination ${row.id} names unknown provider "${row.provider}".`,
    });
  }

  return DestinationSchema.parse({
    id: toPublicId('destination', row.id),
    object: 'destination',
    connection_id: toPublicId('connection', row.connectionId),
    profile_id: toPublicId('profile', row.profileId),
    provider: row.provider,
    destination_type: row.destinationType,
    name: row.name,
    handle: row.handle,
    avatar_url: row.avatarUrl,
    url: row.url,
    selected: row.selected,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

connections.get('/', withDatabase(), authenticate(['connections:read']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, ListConnectionsQuerySchema);

  const cursor = query.cursor ? fromPublicId('connection', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not a valid connection id.' });
  }

  let profileId: string | undefined;
  if (query.profile_id) {
    const resolved = fromPublicId('profile', query.profile_id);
    if (!resolved) {
      throw new ApiError('INVALID_REQUEST', { message: '`profile_id` is not a valid profile id.' });
    }
    profileId = resolved;
  }

  const { rows, hasMore } = await listConnections(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit,
    order: query.order,
    cursor: cursor ?? undefined,
    profileId,
    provider: query.provider,
    health: query.health,
    includeDisconnected: query.include_disconnected,
    restrictedToProfileId: principal.restrictedToProfileId,
  });

  const data = rows.map(toConnectionResponse);

  return c.json(
    ConnectionListResponseSchema.parse({
      object: 'list',
      data,
      has_more: hasMore,
      next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    }),
    200,
  );
});

/**
 * Load a connection and enforce both halves of authorization.
 *
 * The environment filter in the query pins the tenant; the explicit check covers
 * profile-restricted keys, which the filter does not. Every connection route needs both,
 * and doing it in one place is what stops the third route from remembering only one.
 */
async function loadOwnedConnection(
  c: Context<AppEnv>,
  connectionId: string,
): Promise<ConnectionWithScopes> {
  const principal = c.get('principal');

  const row = await findConnectionById(c.get('db'), principal.projectEnvironmentId, connectionId);
  if (!row) throw new ApiError('CONNECTION_NOT_FOUND');

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== row.profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return row;
}

connections.get('/:connectionId', withDatabase(), authenticate(['connections:read']), async (c) => {
  const connectionId = requirePathId(c, 'connection', 'connectionId');
  return c.json(toConnectionResponse(await loadOwnedConnection(c, connectionId)), 200);
});

connections.get(
  '/:connectionId/destinations',
  withDatabase(),
  authenticate(['destinations:read']),
  async (c) => {
    const principal = c.get('principal');
    const connectionId = requirePathId(c, 'connection', 'connectionId');

    // The connection is loaded first rather than querying destinations directly: it
    // establishes ownership, and it distinguishes "no such connection" from "a connection
    // with no destinations", which are different problems for the caller.
    await loadOwnedConnection(c, connectionId);

    const rows = await listDestinationsForConnection(
      c.get('db'),
      principal.projectEnvironmentId,
      connectionId,
    );

    return c.json(
      DestinationListResponseSchema.parse({
        object: 'list',
        data: rows.map(toDestinationResponse),
        // Destinations per connection are bounded by what the provider returns — a
        // handful, not a stream. Paginating them would add a cursor nobody needs.
        has_more: false,
        next_cursor: null,
      }),
      200,
    );
  },
);

connections.post(
  '/:connectionId/disconnect',
  withDatabase(),
  authenticate(['connections:write']),
  async (c) => {
    const principal = c.get('principal');
    const connectionId = requirePathId(c, 'connection', 'connectionId');

    await loadOwnedConnection(c, connectionId);
    await disconnectConnection(c.get('db'), principal.projectEnvironmentId, connectionId);

    // Already-disconnected is success, not a conflict: the caller's intent is satisfied
    // either way, and erroring would punish a client that retried after a dropped
    // response (P4).
    return c.json(
      DisconnectConnectionResponseSchema.parse({
        id: toPublicId('connection', connectionId),
        object: 'connection',
        disconnected: true,
        // Provider-side revocation is performed by the adapter and lands with the connect
        // flow. Reporting it honestly as unconfirmed beats implying it happened.
        revoked_at_provider: false,
      }),
      200,
    );
  },
);
