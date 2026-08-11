import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  authStrategyEnum,
  connectionHealthEnum,
  credentialTypeEnum,
  oauthSessionStatusEnum,
  providerAppOwnershipEnum,
} from './enums.js';
import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * Connection and destination model (plan §8.5, §21, §23).
 *
 * The central distinction, which must never be collapsed:
 *
 *   Connection  = one authorization / credential relationship with a provider
 *   Destination = one actual publishing target
 *
 * One Facebook OAuth grant may expose several Pages; one LinkedIn authorization may
 * expose several organizations; Google Business may expose many locations. Modelling
 * these as the same object is the mistake that forces a schema rewrite at provider four.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * OAuth applications (plan §23).
 *
 * `project_id` NULL means a platform-managed app shared by all customers — the default,
 * and what makes onboarding a single click. Enterprise customers later bring their own
 * Meta/TikTok/Google/LinkedIn app by inserting a row with `project_id` set. That path
 * exists in the schema from day one specifically so enabling it is not a rewrite.
 */
export const providerApps = pgTable(
  'provider_apps',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    provider: text('provider').notNull(),
    ownership: providerAppOwnershipEnum('ownership').notNull().default('platform_managed'),
    clientId: text('client_id'),
    /** Encrypted with @gs/crypto. Never a plaintext column (plan P9). */
    encryptedClientSecret: jsonb('encrypted_client_secret').$type<{
      ciphertext: string;
      nonce: string;
      algorithm: string;
      keyVersion: number;
    }>(),
    callbackConfig: jsonb('callback_config').$type<Record<string, unknown>>().notNull().default({}),
    /** Where the provider's app review stands. Blocks going live on that provider. */
    approvalStatus: text('approval_status').notNull().default('not_submitted'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    isDefault: boolean('is_default').notNull().default(false),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('provider_apps_provider_idx').on(table.provider),
    index('provider_apps_project_idx').on(table.projectId),
    // At most one default platform-managed app per provider.
    uniqueIndex('provider_apps_default_platform_key')
      .on(table.provider)
      .where(sql`${table.projectId} IS NULL AND ${table.isDefault} = true`),
  ],
);

/**
 * Short-lived OAuth handshake state (plan §21.1).
 *
 * `state` is unique so a callback cannot be replayed, and consumption is an atomic
 * conditional UPDATE rather than a read-then-write — a duplicated callback from a
 * provider (or an attacker replaying one) must not exchange the code twice.
 */
export const oauthSessions = pgTable(
  'oauth_sessions',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    providerAppId: uuid('provider_app_id')
      .notNull()
      .references(() => providerApps.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    /** Cryptographically random. The primary CSRF defence on the callback. */
    state: text('state').notNull(),
    /** PKCE verifier for `oauth2_pkce` providers. Encrypted at rest. */
    encryptedCodeVerifier: jsonb('encrypted_code_verifier').$type<{
      ciphertext: string;
      nonce: string;
      algorithm: string;
      keyVersion: number;
    }>(),
    /** Validated against an allow-list before redirecting, never trusted as supplied. */
    redirectUri: text('redirect_uri').notNull(),
    returnUrl: text('return_url'),
    requestedScopes: text('requested_scopes').array().notNull().default(sql`'{}'::text[]`),
    /** Set when the flow started from a hosted connect session (plan §22). */
    connectSessionId: uuid('connect_session_id'),
    /** Reconnecting an existing connection rather than creating a new one. */
    reconnectConnectionId: uuid('reconnect_connection_id'),
    status: oauthSessionStatusEnum('status').notNull().default('pending'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    traceId: text('trace_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('oauth_sessions_state_key').on(table.state),
    index('oauth_sessions_profile_idx').on(table.profileId),
    index('oauth_sessions_expiry_idx').on(table.expiresAt).where(sql`${table.status} = 'pending'`),
  ],
);

/** Hosted white-label connect sessions (plan §22). */
export const connectSessions = pgTable(
  'connect_sessions',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    providers: text('providers').array().notNull(),
    branding: jsonb('branding').$type<Record<string, unknown>>().notNull().default({}),
    returnUrl: text('return_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdByApiKeyId: uuid('created_by_api_key_id'),
    ...timestamps,
  },
  (table) => [
    index('connect_sessions_profile_idx').on(table.profileId),
    index('connect_sessions_expiry_idx').on(table.expiresAt),
  ],
);

/** One authorization relationship with a provider, owned by exactly one profile. */
export const socialConnections = pgTable(
  'social_connections',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerAppId: uuid('provider_app_id').references(() => providerApps.id, {
      onDelete: 'restrict',
    }),
    provider: text('provider').notNull(),
    authStrategy: authStrategyEnum('auth_strategy').notNull(),

    /** The provider's stable identifier for the authenticated identity. */
    providerAccountId: text('provider_account_id').notNull(),
    providerAccountName: text('provider_account_name'),
    providerAccountHandle: text('provider_account_handle'),
    providerAccountAvatarUrl: text('provider_account_avatar_url'),

    health: connectionHealthEnum('health').notNull().default('healthy'),
    healthDetail: text('health_detail'),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),

    /**
     * Some providers require a secondary selection (a Page, an organization, a board)
     * before the connection can publish (plan §21.3). Until that happens the connection
     * exists but is not usable, and preflight says so with
     * CONNECTION_INCOMPLETE_SETUP rather than failing at publish time.
     */
    setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),

    /** Serializes token refresh so two workers cannot rotate a refresh token at once. */
    refreshLockedUntil: timestamp('refresh_locked_until', { withTimezone: true }),

    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('social_connections_profile_provider_health_idx').on(
      table.profileId,
      table.provider,
      table.health,
    ),
    index('social_connections_environment_idx').on(table.projectEnvironmentId),
    /**
     * One live connection per (profile, provider, provider account). Reconnecting the
     * same account updates this row rather than creating a duplicate, so a customer
     * re-authorizing does not silently end up with two connections and double posts.
     */
    uniqueIndex('social_connections_profile_provider_account_key')
      .on(table.profileId, table.provider, table.providerAccountId)
      .where(sql`${table.disconnectedAt} IS NULL`),
  ],
);

/**
 * Encrypted credentials (plan §7.1, ADR-007).
 *
 * A separate table rather than columns on `social_connections`, so that reading a
 * connection for a listing endpoint does not pull ciphertext into memory, and so access
 * to credentials is a distinct, auditable query.
 */
export const socialCredentials = pgTable(
  'social_credentials',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => socialConnections.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    credentialType: credentialTypeEnum('credential_type').notNull(),

    /**
     * Set when the provider issues a credential per publishable surface rather than per
     * authorization. A Meta Page access token is the canonical case: the user token that
     * enumerated the Pages cannot publish to any of them, so the token that can must be
     * stored against the Page. NULL means the credential belongs to the connection.
     */
    destinationId: uuid('destination_id').references(() => socialDestinations.id, {
      onDelete: 'cascade',
    }),

    ciphertext: text('ciphertext').notNull(),
    nonce: text('nonce').notNull(),
    algorithm: text('algorithm').notNull().default('AES-256-GCM'),
    /** Which KEK version encrypted this. Rotation reads old versions, writes the new. */
    keyVersion: integer('key_version').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    /**
     * Two partial indexes rather than one composite over three columns. Postgres treats
     * NULLs as distinct, so a composite index including `destination_id` would not
     * constrain connection-level rows at all — two access tokens for one connection would
     * be accepted, which is the "which one is current?" ambiguity this constraint exists
     * to prevent.
     */
    uniqueIndex('social_credentials_connection_type_key')
      .on(table.connectionId, table.credentialType)
      .where(sql`${table.destinationId} IS NULL`),
    uniqueIndex('social_credentials_destination_type_key')
      .on(table.destinationId, table.credentialType)
      .where(sql`${table.destinationId} IS NOT NULL`),
    index('social_credentials_destination_idx')
      .on(table.destinationId)
      .where(sql`${table.destinationId} IS NOT NULL`),
    // Drives the proactive token-refresh sweep before anything expires mid-publish.
    index('social_credentials_expiry_idx').on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  ],
);

/** Scopes the provider actually granted — which is not always what we asked for. */
export const connectionScopes = pgTable(
  'connection_scopes',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => socialConnections.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    granted: boolean('granted').notNull().default(true),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('connection_scopes_connection_scope_key').on(table.connectionId, table.scope)],
);

/**
 * An actual publishing target: a Page, an organization, a board, a channel, a location,
 * or the authenticated user themselves.
 */
export const socialDestinations = pgTable(
  'social_destinations',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => socialConnections.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    /** The provider's ID for this target: page ID, organization URN, board ID, DID. */
    providerDestinationId: text('provider_destination_id').notNull(),
    /** `page`, `organization`, `board`, `channel`, `location`, `user`, … */
    destinationType: text('destination_type').notNull(),
    name: text('name').notNull(),
    handle: text('handle'),
    avatarUrl: text('avatar_url'),
    url: text('url'),

    /** Selected by the end user in the connect flow. Unselected targets stay visible
     *  but unusable, so a customer can add one later without re-authorizing. */
    selected: boolean('selected').notNull().default(true),
    /**
     * Effective capability for THIS destination (plan §17) — differs from generic
     * provider capability by scopes, account type, subscription and rollout.
     * Cached here and refreshed on connect and on health checks.
     */
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
    capabilitiesRefreshedAt: timestamp('capabilities_refreshed_at', { withTimezone: true }),

    removedAt: timestamp('removed_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('social_destinations_connection_provider_id_key').on(
      table.connectionId,
      table.providerDestinationId,
    ),
    index('social_destinations_profile_idx').on(table.profileId),
    index('social_destinations_environment_idx').on(table.projectEnvironmentId),
  ],
);

/** Append-only connection health history (plan §42). Powers "why did this stop working?". */
export const connectionHealthEvents = pgTable(
  'connection_health_events',
  {
    id: uuid('id').primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => socialConnections.id, { onDelete: 'cascade' }),
    fromHealth: connectionHealthEnum('from_health'),
    toHealth: connectionHealthEnum('to_health').notNull(),
    reason: text('reason'),
    /** Normalized provider error code that triggered the transition (plan §79). */
    providerErrorCode: text('provider_error_code'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('connection_health_events_connection_created_idx').on(table.connectionId, table.createdAt)],
);

// ---------------------------------------------------------------------------

export const socialConnectionsRelations = relations(socialConnections, ({ one, many }) => ({
  profile: one(profiles, { fields: [socialConnections.profileId], references: [profiles.id] }),
  providerApp: one(providerApps, {
    fields: [socialConnections.providerAppId],
    references: [providerApps.id],
  }),
  destinations: many(socialDestinations),
  credentials: many(socialCredentials),
  scopes: many(connectionScopes),
  healthEvents: many(connectionHealthEvents),
}));

export const socialDestinationsRelations = relations(socialDestinations, ({ one }) => ({
  connection: one(socialConnections, {
    fields: [socialDestinations.connectionId],
    references: [socialConnections.id],
  }),
  profile: one(profiles, { fields: [socialDestinations.profileId], references: [profiles.id] }),
}));

export const socialCredentialsRelations = relations(socialCredentials, ({ one }) => ({
  connection: one(socialConnections, {
    fields: [socialCredentials.connectionId],
    references: [socialConnections.id],
  }),
}));

export type ProviderApp = typeof providerApps.$inferSelect;
export type OAuthSession = typeof oauthSessions.$inferSelect;
export type ConnectSession = typeof connectSessions.$inferSelect;
export type SocialConnection = typeof socialConnections.$inferSelect;
export type SocialCredential = typeof socialCredentials.$inferSelect;
export type SocialDestination = typeof socialDestinations.$inferSelect;
export type ConnectionHealthEvent = typeof connectionHealthEvents.$inferSelect;
