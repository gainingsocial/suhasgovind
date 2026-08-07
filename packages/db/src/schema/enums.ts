import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Database enums for the state machines in plan §12.
 *
 * These are real Postgres enums rather than text columns because the publishing engine's
 * correctness depends on them: the target lease in ADR-006 Layer 2 filters on
 * `status IN (...)`, and a typo in a status string would silently make that filter match
 * nothing — a target that never publishes, with no error anywhere.
 *
 * Adding a value is a migration (`ALTER TYPE ... ADD VALUE`). Removing one is not
 * supported by Postgres and requires a type swap, which is the correct amount of friction
 * for changing a state machine.
 */

// ---- tenancy ---------------------------------------------------------------

export const environmentKindEnum = pgEnum('environment_kind', ['test', 'live']);

export const organizationRoleEnum = pgEnum('organization_role', [
  'owner',
  'admin',
  'developer',
  'marketer',
  'analyst',
  'billing',
  'viewer',
]);

// ---- connections (plan §12.3) ----------------------------------------------

export const connectionHealthEnum = pgEnum('connection_health', [
  'healthy',
  'refresh_due',
  'refreshing',
  'reauth_required',
  'permission_missing',
  'rate_limited',
  'provider_degraded',
  'disconnected',
  'revoked',
]);

/** Plan §20 — providers are not all OAuth, and assuming so breaks on the first that isn't. */
export const authStrategyEnum = pgEnum('auth_strategy', [
  'oauth2',
  'oauth2_pkce',
  'oauth1',
  'manual_token',
  'bot_token',
  'webhook_url',
  'api_key',
  'app_password',
  'custom',
]);

export const credentialTypeEnum = pgEnum('credential_type', [
  'access_token',
  'refresh_token',
  'app_password',
  'bot_token',
  'api_key',
  'webhook_url',
  'oauth1_token',
  'oauth1_token_secret',
  'client_secret',
]);

export const providerAppOwnershipEnum = pgEnum('provider_app_ownership', [
  'platform_managed',
  'customer_managed',
]);

export const oauthSessionStatusEnum = pgEnum('oauth_session_status', [
  'pending',
  'consumed',
  'expired',
  'failed',
]);

// ---- media -----------------------------------------------------------------

export const mediaStatusEnum = pgEnum('media_status', [
  'awaiting_upload',
  'uploaded',
  'probing',
  'ready',
  'failed',
  'deleted',
]);

export const mediaKindEnum = pgEnum('media_kind', ['image', 'video', 'audio', 'document']);

export const mediaSourceEnum = pgEnum('media_source', ['upload', 'external_url', 'derived']);

// ---- posts (plan §12.1, §12.2) ---------------------------------------------

export const postStatusEnum = pgEnum('post_status', [
  'draft',
  'validating',
  'awaiting_approval',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
]);

export const postTargetStatusEnum = pgEnum('post_target_status', [
  'pending',
  'blocked_validation',
  'awaiting_approval',
  'scheduled',
  'queued',
  'preparing_media',
  'publishing',
  'provider_processing',
  'published',
  'retryable_failed',
  'permanent_failed',
  'cancelled',
  /** The outcome is genuinely unknown. Never retried without reconciliation (ADR-006). */
  'unknown_reconciliation_required',
]);

export const attemptOutcomeEnum = pgEnum('attempt_outcome', [
  'published',
  'provider_processing',
  'retryable_failed',
  'permanent_failed',
  'unknown_reconciliation_required',
  'skipped',
]);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

// ---- idempotency (plan §77) ------------------------------------------------

export const idempotencyStatusEnum = pgEnum('idempotency_status', [
  /** Reserved but the resource does not exist yet. A concurrent caller must wait. */
  'in_progress',
  'completed',
  'failed',
]);

// ---- webhooks (plan §36) ---------------------------------------------------

export const webhookEndpointStatusEnum = pgEnum('webhook_endpoint_status', [
  'enabled',
  'disabled',
  'auto_disabled',
]);

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
  'pending',
  'delivering',
  'succeeded',
  'failed_retryable',
  'exhausted',
]);

// ---- api keys (plan §38) ---------------------------------------------------

export const apiKeyStatusEnum = pgEnum('api_key_status', ['active', 'revoked', 'expired']);

// ---- audit / usage ---------------------------------------------------------

export const actorTypeEnum = pgEnum('actor_type', ['user', 'api_key', 'system', 'agent']);
