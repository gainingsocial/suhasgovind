import {
  ConnectionSchema,
  DestinationSchema,
  type Connection as ConnectionResponse,
  type Destination as DestinationResponse,
} from '@gs/contracts/http';
import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import type { ConnectionWithScopes, SocialDestination } from '@gs/db';
import { ApiError } from '@gs/errors';

/**
 * Row → public shape for connections and destinations.
 *
 * Extracted because three route files now render these — listing, connecting, selecting
 * destinations — and a second copy of the mapping is how one of them starts returning a
 * field the others do not.
 */

/**
 * A connection response deliberately carries no credential material — not the token, not
 * its ciphertext, not its expiry-derived secrets (P9, §7.2). Health and scopes are the
 * observable surface, and they are enough to explain any failure a caller will see.
 */
export function toConnectionResponse(row: ConnectionWithScopes): ConnectionResponse {
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

export function toDestinationResponse(row: SocialDestination): DestinationResponse {
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
