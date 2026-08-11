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
  /**
   * Round-trip this on `POST /v1/connections/complete` for providers with no consent
   * screen. For OAuth providers it travels through the provider instead and is not needed
   * by the caller — but it is returned either way so one client can handle both.
   */
  state: z.string(),
  /**
   * `redirect` — send the user to `authorization_url` and wait for the callback.
   * `credential` — the platform has no consent screen; collect the fields named in
   * `required_credential_fields` and submit them to `/v1/connections/complete`.
   * Branching on this rather than on the provider name is what stops a client needing a
   * hard-coded list of which platforms use OAuth.
   */
  completion: z.enum(['redirect', 'credential']),
  /** Field names to collect when `completion` is `credential`. Empty otherwise. */
  required_credential_fields: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      /** `password` fields must never be echoed back or logged by the collecting client. */
      type: z.enum(['text', 'password']),
      help: z.string().nullable(),
    }),
  ),
  expires_at: z.iso.datetime(),
});

/**
 * Finish an authorization that has no consent screen (plan §20, §21.2).
 *
 * Bluesky app passwords and Telegram bot tokens arrive this way. The credential is
 * validated against the provider before anything is stored, so a typo fails here rather
 * than at publish time.
 */
export const CompleteConnectionRequestSchema = z.object({
  /** The `state` returned by `POST /v1/connections/authorize`. */
  state: z.string().min(16),
  /**
   * Provider-specific credential fields, exactly as named in `required_credential_fields`.
   * These are secrets: they are encrypted on arrival and never returned by any endpoint.
   */
  credentials: z.record(z.string().max(64), z.string().min(1).max(4096)),
});

export const CompleteConnectionResponseSchema = z.object({
  object: z.literal('connection'),
  id: z.string(),
  provider: ProviderNameSchema,
  provider_account_name: z.string(),
  /** False when this re-authorized a connection that already existed. */
  created: z.boolean(),
  /**
   * True when the connection can publish now. False means a destination still has to be
   * chosen — the account authorized several Pages and picking for the user would be a
   * guess that publishes to the wrong place.
   */
  setup_complete: z.boolean(),
  destination_count: z.number().int().nonnegative(),
  granted_scopes: z.array(z.string()),
});

/** Choose which destinations a connection publishes to (plan §21.3). */
export const SelectDestinationsRequestSchema = z.object({
  /** Destination ids to enable. An empty array disables every destination. */
  destination_ids: z.array(z.string()).max(100),
});

/**
 * Create a hosted white-label connect session (plan §22).
 *
 * The returned URL is handed to the customer's own end user, who has no account with us.
 * It carries its own signed authorization and expires quickly.
 */
export const CreateConnectSessionRequestSchema = z.object({
  profile_id: z.string(),
  /** Platforms to offer. Defaults to every platform with a working adapter. */
  providers: z.array(ProviderNameSchema).min(1).max(20).optional(),
  branding: z
    .object({
      logo_url: z.url().optional(),
      /** Hex colour used for primary actions on the hosted page. */
      accent: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'accent must be a 6-digit hex colour, e.g. #FFCC00')
        .optional(),
      company_name: z.string().max(120).optional(),
    })
    .default({}),
  /** Where to send the user when they are finished. Must be absolute HTTPS. */
  return_url: z.url().optional(),
  /** Seconds until the link stops working. Short by default: it is a bearer credential. */
  expires_in: z.number().int().min(60).max(86_400).default(900),
});

export const ConnectSessionResponseSchema = z.object({
  object: z.literal('connect_session'),
  id: z.string(),
  profile_id: z.string(),
  providers: z.array(ProviderNameSchema),
  /** Send the end user here. Signed, single-purpose, and expiring. */
  url: z.url(),
  return_url: z.url().nullable(),
  expires_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
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

/**
 * Platform application credentials (plan §23).
 *
 * The mechanism that turns a granted platform approval into a data change rather than a
 * deploy. Authenticated by a dashboard session, never by an API key: a client secret is
 * the key to every connection ever made through that application, so an API key that
 * could write one would be a far worse leak than the key itself.
 */
export const ProviderAppSchema = z.object({
  id: z.string(),
  object: z.literal('provider_app'),
  provider: ProviderNameSchema,
  ownership: z.enum(['platform_managed', 'customer_managed']),
  /** Public half of the credential pair. The secret is never returned by any endpoint. */
  client_id: z.string().nullable(),
  /** False until a client id and secret have been stored. */
  configured: z.boolean(),
  approval_status: z.string(),
  scopes: z.array(z.string()),
  /** The URL to register with the platform. Copy it into their developer console. */
  redirect_uri: z.string(),
  updated_at: z.iso.datetime(),
});

export const ProviderAppListResponseSchema = listResponseSchema(ProviderAppSchema);

export const UpsertProviderAppRequestSchema = z.object({
  provider: ProviderNameSchema,
  client_id: z.string().min(1).max(255),
  /** Encrypted on arrival and never readable afterwards, exactly like a user token. */
  client_secret: z.string().min(1).max(4096),
  /**
   * `customer_managed` — your own platform application, scoped to your project and
   * invisible to everyone else. This is the default and the only value most callers can
   * use.
   *
   * `platform_managed` — the shared application every customer connects through.
   * Restricted to platform operators, because one shared app authorizes every connection
   * on the system and an org admin must not be able to replace or delete it.
   */
  ownership: z.enum(['customer_managed', 'platform_managed']).default('customer_managed'),
  /** Scopes to request at consent time. The adapter's defaults apply when omitted. */
  scopes: z.array(z.string()).max(50).default([]),
  /**
   * Where the platform's review stands. Free text because every platform names its stages
   * differently, and forcing them into one enum loses the detail that matters.
   */
  approval_status: z.string().max(64).default('approved'),
});

export const DeleteProviderAppResponseSchema = z.object({
  id: z.string(),
  object: z.literal('provider_app'),
  deleted: z.literal(true),
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

/**
 * Provider health (plan §41).
 *
 * Derived from what actually happened — recent publish attempts — rather than read from a
 * status table somebody has to remember to update. A derived answer cannot go stale, and
 * "is Instagram working right now" is a question the attempt record already answers.
 *
 * Scoped to the caller's own environment. A global figure would tell an integrator that
 * the platform is fine while every one of *their* posts is failing on an expired token,
 * which is worse than saying nothing.
 */
export const ProviderHealthSchema = z.object({
  provider: ProviderNameSchema,
  object: z.literal('provider_health'),
  /**
   * `operational` — publishing normally.
   * `degraded` — failing more than occasionally.
   * `failing` — nothing has succeeded in the window.
   * `no_recent_activity` — nothing was attempted, so nothing is known. Deliberately not
   * reported as healthy: an absence of failures is not evidence of success.
   */
  status: z.enum(['operational', 'degraded', 'failing', 'no_recent_activity']),
  /** Fraction of recent attempts that succeeded, or null when there were none. */
  success_rate: z.number().min(0).max(1).nullable(),
  attempts: z.number().int().nonnegative(),
  last_success_at: z.iso.datetime().nullable(),
  last_failure_at: z.iso.datetime().nullable(),
  /** Normalized code from the most recent failure (plan §79). */
  last_error_code: z.string().nullable(),
});

export const ProviderHealthResponseSchema = z.object({
  object: z.literal('list'),
  /** How far back the figures look. */
  window_hours: z.number().int().positive(),
  data: z.array(ProviderHealthSchema),
});

export const CapabilitiesResponseSchema = ProviderCapabilitiesSchema;
