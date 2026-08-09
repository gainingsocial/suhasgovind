import { z } from 'zod';

import { listResponseSchema, PaginationQuerySchema } from '../common/pagination.js';
import { AuthStrategySchema, ProviderNameSchema } from '../common/providers.js';
import { ProviderCapabilitiesSchema } from '../providers/capabilities.js';

/**
 * Connection and destination contracts (plan §8.5, §14, §21).
 *
 * Connection and destination are separate objects, and keeping them separate is the
 * decision that avoids a schema rewrite at provider four. One authorization commonly
 * yields several publishable surfaces — a Meta login yields N Pages, a LinkedIn login
 * yields the member plus their organizations — and modelling them as one thing forces a
 * rewrite the first time a provider does that.
 */

/** Plan §12.3. A connection is a live thing that degrades; it is not merely present. */
export const ConnectionHealthSchema = z.enum([
  'healthy',
  /** Token nearing expiry; a proactive refresh is due. Still publishes. */
  'refresh_due',
  'refreshing',
  /** A human must re-authorize. Retrying cannot help. */
  'reauth_required',
  'permission_missing',
  'rate_limited',
  'provider_degraded',
  'disconnected',
  'revoked',
]);

export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;

export const DestinationSchema = z.object({
  id: z.string(),
  object: z.literal('destination'),
  connection_id: z.string(),
  profile_id: z.string(),
  provider: ProviderNameSchema,
  /** `page`, `organization`, `board`, `channel`, `location`, `user`, … */
  destination_type: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
  avatar_url: z.string().nullable(),
  url: z.string().nullable(),
  /**
   * Whether the end user chose this destination during connect. Unselected destinations
   * stay visible so one can be enabled later without re-authorizing.
   */
  selected: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type Destination = z.infer<typeof DestinationSchema>;

export const ConnectionSchema = z.object({
  id: z.string(),
  object: z.literal('connection'),
  profile_id: z.string(),
  provider: ProviderNameSchema,
  auth_strategy: AuthStrategySchema,
  /** The provider's stable identifier for the authenticated identity. */
  provider_account_id: z.string(),
  provider_account_name: z.string().nullable(),
  provider_account_handle: z.string().nullable(),
  provider_account_avatar_url: z.string().nullable(),
  health: ConnectionHealthSchema,
  /** Why the connection is not healthy, in plain terms. Null when it is. */
  health_detail: z.string().nullable(),
  health_checked_at: z.iso.datetime().nullable(),
  /**
   * Null until any required secondary selection is done (plan §21.3). A connection can
   * exist and still be unusable, and preflight reports that rather than letting it fail
   * at publish time.
   */
  setup_completed_at: z.iso.datetime().nullable(),
  /** Scopes the provider actually granted, which is not always what was requested. */
  granted_scopes: z.array(z.string()),
  connected_at: z.iso.datetime(),
  disconnected_at: z.iso.datetime().nullable(),
  last_used_at: z.iso.datetime().nullable(),
});

export type Connection = z.infer<typeof ConnectionSchema>;

/**
 * Start an authorization (plan §21.1).
 *
 * Returns a URL the end user visits. For strategies with no consent screen — Bluesky's
 * app passwords, a Telegram bot token — the same call still applies, so the connect flow
 * has one shape rather than branching per provider (plan §20).
 */
export const AuthorizeConnectionRequestSchema = z.object({
  profile_id: z.string(),
  provider: ProviderNameSchema,
  /** Where to send the user after the provider redirects back. Must be absolute HTTPS. */
  redirect_url: z.url(),
  /**
   * Additional scopes beyond the adapter's defaults. Requesting more than needed makes a
   * consent screen scarier and lowers completion, so this is opt-in.
   */
  scopes: z.array(z.string()).optional(),
  /** Echoed back on the callback. Use it to correlate with your own flow. */
  state_metadata: z.record(z.string().max(64), z.string()).optional(),
});

export const AuthorizeConnectionResponseSchema = z.object({
  object: z.literal('authorization'),
  /** Send the end user here. */
  authorization_url: z.url(),
  /** Opaque handle for the pending authorization. Expires. */
  oauth_session_id: z.string(),
  expires_at: z.iso.datetime(),
});

export const ListConnectionsQuerySchema = PaginationQuerySchema.extend({
  profile_id: z.string().optional(),
  provider: ProviderNameSchema.optional(),
  health: ConnectionHealthSchema.optional(),
  /** Disconnected connections are excluded unless asked for. */
  include_disconnected: z.stringbool().default(false),
});

export const ConnectionListResponseSchema = listResponseSchema(ConnectionSchema);
export const DestinationListResponseSchema = listResponseSchema(DestinationSchema);

export const DisconnectConnectionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('connection'),
  disconnected: z.literal(true),
  /**
   * Whether the provider confirmed revocation. False when the provider offers no
   * revocation endpoint, or when the call failed — the local connection is disconnected
   * either way, and saying which happened is more useful than implying success.
   */
  revoked_at_provider: z.boolean(),
});

export const RefreshConnectionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('connection'),
  health: ConnectionHealthSchema,
  /** False when the existing credential was still valid and nothing was rotated. */
  rotated: z.boolean(),
});

/** `GET /v1/platforms` — what the product supports, and what is merely planned. */
export const PlatformSchema = z.object({
  provider: ProviderNameSchema,
  object: z.literal('platform'),
  display_name: z.string(),
  auth_strategy: AuthStrategySchema.nullable(),
  /** False for a provider on the roadmap with no adapter yet. */
  available: z.boolean(),
  /** True when connecting requires a registered platform application (plan §23). */
  requires_provider_app: z.boolean(),
});

export const PlatformListResponseSchema = listResponseSchema(PlatformSchema);

export const CapabilitiesResponseSchema = ProviderCapabilitiesSchema;
