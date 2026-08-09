import type { AuthStrategy, ProviderName } from '@gs/contracts/providers';
import type { MediaKind } from '@gs/contracts/capabilities';

/**
 * Shared value types crossing the adapter boundary (plan §19).
 *
 * Nothing here is provider-specific. An adapter receives these, and everything it knows
 * about its own platform stays behind the interface (plan P1).
 */

/** Every adapter call carries this. Timeouts and observability are not optional (Rule 6). */
export interface ProviderCallContext {
  /** Propagated from the inbound request so a provider call is traceable end to end. */
  readonly requestId: string;
  readonly traceId: string;
  /**
   * Hard deadline for the whole operation. An adapter MUST respect it — a provider call
   * without a timeout is how a Worker hits its wall-clock limit with no diagnosis.
   */
  readonly signal: AbortSignal;
  /**
   * `test` routes to the provider's sandbox where one exists, and to the mock otherwise
   * (plan §49). An adapter must never perform a real side effect in `test`.
   */
  readonly environment: 'test' | 'live';
  /**
   * Records a sanitized provider request/response pair (plan §40, P10).
   * Implementations redact before persisting; adapters must still never pass a
   * credential into it (P9, §7.2).
   */
  readonly log: (entry: ProviderCallLogEntry) => void;
}

export interface ProviderCallLogEntry {
  operation: string;
  method: string;
  /** Path only — never a URL carrying a token in its query string. */
  path: string;
  status?: number;
  durationMs: number;
  /** Provider's own request identifier, when it returns one. Invaluable in support tickets. */
  providerRequestId?: string;
  /** Already-redacted excerpt. Never a full payload, never a credential. */
  detail?: Record<string, unknown>;
}

/**
 * Decrypted provider credentials.
 *
 * Only ever constructed by `@gs/crypto` immediately before a provider call (P9, §7.2),
 * and never logged, serialized or persisted by an adapter.
 */
export interface ProviderCredentials {
  readonly strategy: AuthStrategy;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** `app_password`, `bot_token`, `api_key` strategies put the secret here. */
  readonly secret?: string;
  /** OAuth 1.0a needs both halves. */
  readonly tokenSecret?: string;
  /** Provider-side account identifier this credential authenticates as. */
  readonly externalAccountId?: string;
  /** UTC ISO-8601. Absent when the credential does not expire. */
  readonly expiresAt?: string;
  /** Scopes the provider actually granted, which may be fewer than requested. */
  readonly grantedScopes: readonly string[];
  /**
   * Non-secret, strategy-specific extras — a Bluesky PDS endpoint, a Meta page id.
   * Must not hold anything secret; it is not treated as sensitive downstream.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * The registered platform application (plan §23).
 *
 * `null` for strategies where `requiresProviderApp` is false — Bluesky and Telegram have
 * no app to register, so an adapter for either must work without one. An adapter that
 * needs an app and receives `null` must fail with a clear error (Rule 14) rather than
 * dereferencing undefined.
 */
export interface ProviderAppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Extra registration values some platforms need, e.g. a TikTok client key. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Authentication (plan §21)
// ---------------------------------------------------------------------------

export interface CreateAuthorizationInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  /** Opaque value the engine round-trips through the provider to defeat CSRF. */
  readonly state: string;
  readonly requestedScopes: readonly string[];
  /** Provider-specific knobs for the consent screen, e.g. forcing re-consent. */
  readonly options: Readonly<Record<string, unknown>>;
}

export interface AuthRedirect {
  readonly authorizationUrl: string;
  /** Stored encrypted and replayed at callback for `oauth2_pkce` (plan §21.1). */
  readonly codeVerifier?: string;
  /** Echoed back so the engine can assert the adapter used the state it was given. */
  readonly state: string;
}

export interface AuthCallbackInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  /** Raw callback query parameters. The adapter interprets them; the engine does not. */
  readonly query: Readonly<Record<string, string>>;
  readonly codeVerifier?: string;
}

export interface AuthResult {
  readonly credentials: ProviderCredentials;
  readonly identity: ConnectionIdentity;
}

export interface RefreshCredentialInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
}

export interface RefreshResult {
  readonly credentials: ProviderCredentials;
  /**
   * False when the provider returned the same still-valid credential rather than a new
   * one. The engine skips the re-encrypt and the write when nothing changed.
   */
  readonly rotated: boolean;
}

export interface RevokeCredentialInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
}

export interface InspectCredentialInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
}

/** Who a credential authenticates as. Shown in the dashboard's connection list. */
export interface ConnectionIdentity {
  readonly externalAccountId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  /** Provider's own account classification, e.g. `business`, `creator`, `personal`. */
  readonly accountType: string | null;
  readonly grantedScopes: readonly string[];
}

// ---------------------------------------------------------------------------
// Destinations (plan §8.5)
// ---------------------------------------------------------------------------

export interface ListDestinationsInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
}

/**
 * One publishable surface behind a connection — a Page, an IG account, a board, a
 * channel. One connection commonly yields several, which is exactly why connection and
 * destination are separate tables (plan §8.5).
 */
export interface ProviderDestination {
  readonly externalId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  /** Provider's own kind, e.g. `page`, `board`, `channel`, `organization`. */
  readonly kind: string;
  /**
   * Per-destination credential material where the platform issues one — a Meta Page
   * access token differs from the user token that listed the Page. Encrypted by the
   * engine exactly like a connection credential.
   */
  readonly credentials?: ProviderCredentials;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Publishing (plan §24)
// ---------------------------------------------------------------------------

/** Media as the adapter sees it: already uploaded to R2 and probed (plan §31). */
export interface ResolvedMedia {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly altText: string | null;
  /**
   * Short-lived signed URL the provider (or the adapter) can read the bytes from.
   * Never a permanent public URL — see the SSRF rules in plan §68.
   */
  readonly downloadUrl: string;
}

/** Fully resolved content for one target, overrides already applied (plan §11.2). */
export interface ResolvedTargetContent {
  readonly text: string;
  readonly media: readonly ResolvedMedia[];
  readonly linkUrl: string | null;
  /** Provider-native escape hatch, validated by the adapter (plan §43). */
  readonly providerOptions: Readonly<Record<string, unknown>>;
  /** Compliance metadata some platforms require, e.g. TikTok's commercial disclosure. */
  readonly compliance: Readonly<Record<string, unknown>>;
}

export interface TargetRef {
  readonly postId: string;
  readonly postTargetId: string;
  readonly destinationExternalId: string;
}

export interface ValidateTargetInput {
  readonly context: ProviderCallContext;
  readonly target: TargetRef;
  readonly content: ResolvedTargetContent;
  readonly credentials: ProviderCredentials | null;
  readonly app: ProviderAppCredentials | null;
}

export interface PrepareTargetInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
  readonly target: TargetRef;
  readonly content: ResolvedTargetContent;
}

/**
 * Result of the side-effecting-but-not-yet-published step: media uploaded, container
 * created, upload session opened.
 *
 * Separated from `publish` because these steps are the expensive, slow, retry-prone ones,
 * and because several platforms genuinely model publishing as "create container, then
 * publish container". Keeping `publish` small is what makes the final step cheap to
 * reconcile.
 */
export interface PreparedPublish {
  /** Opaque adapter state handed to `publish`. Persisted, so it must be JSON-serializable. */
  readonly state: Readonly<Record<string, unknown>>;
  /** Provider-side ids created during preparation, for reconciliation and cleanup. */
  readonly providerMediaIds: readonly string[];
}

export interface PublishTargetInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
  readonly target: TargetRef;
  readonly content: ResolvedTargetContent;
  readonly prepared: PreparedPublish;
  /**
   * Stable fingerprint of the resolved content (ADR-006 Layer 3). Adapters pass it to
   * providers that support an idempotency key, which is the cheapest duplicate defence
   * available and must be used wherever the platform offers it.
   */
  readonly idempotencyKey: string;
}

export interface PublishResult {
  /** `published`, or `processing` where the provider transcodes asynchronously. */
  readonly outcome: 'published' | 'processing';
  readonly externalPostId: string;
  readonly externalUrl: string | null;
  /** UTC ISO-8601 (Rule 15). */
  readonly publishedAt: string | null;
  /** Opaque handle for polling when `outcome` is `processing`. */
  readonly statusHandle?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PublishStatusInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
  readonly target: TargetRef;
  readonly statusHandle: string;
}

export interface PublishStatusResult {
  readonly outcome: 'published' | 'processing' | 'failed';
  readonly externalPostId: string | null;
  readonly externalUrl: string | null;
  readonly publishedAt: string | null;
  /** Present when `failed`; already normalized by the adapter. */
  readonly failureReason?: string;
}

/**
 * Reconciliation input (ADR-006 Layer 4).
 *
 * Runs after an ambiguous failure — a timeout, a dropped connection — to answer "did the
 * post actually get created?" before anything is retried. This is the single most
 * important defence against duplicate posts, and plan §2.2 cites it as the failure mode
 * competitors are known for.
 */
export interface ReconcileInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
  readonly target: TargetRef;
  readonly content: ResolvedTargetContent;
  readonly idempotencyKey: string;
  /** Only consider posts created at or after this instant. UTC ISO-8601. */
  readonly attemptedAfter: string;
}

export interface ReconcileResult {
  /**
   * `found` — the post exists; adopt it and do not republish.
   * `absent` — provably nothing was created; retrying is safe.
   * `indeterminate` — could not tell. Rule 14: do NOT retry. Escalate instead.
   */
  readonly conclusion: 'found' | 'absent' | 'indeterminate';
  readonly externalPostId?: string;
  readonly externalUrl?: string;
  readonly publishedAt?: string;
  /** Why the adapter reached `indeterminate`. Surfaced to support, never to a retry loop. */
  readonly reason?: string;
}

export interface DeletePublishedPostInput {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  readonly credentials: ProviderCredentials;
  readonly target: TargetRef;
  readonly externalPostId: string;
}

export interface DeleteResult {
  /** True when the post was already gone. Deleting twice must not be an error (P4). */
  readonly alreadyAbsent: boolean;
}

// ---------------------------------------------------------------------------
// Webhooks (plan §34)
// ---------------------------------------------------------------------------

export interface VerifiedProviderEvent {
  /** False when the signature does not verify. The engine drops the event and alerts. */
  readonly verified: boolean;
  /** Provider's event id, used for dedupe (plan §10.4). */
  readonly externalEventId: string | null;
  readonly eventType: string;
  /** Provider account the event concerns, for routing to a connection. */
  readonly externalAccountId: string | null;
  readonly payload: unknown;
}

export interface CapabilityContext {
  readonly context: ProviderCallContext;
  readonly app: ProviderAppCredentials | null;
  /** Absent for generic capability; present to resolve effective capability (plan §17). */
  readonly credentials?: ProviderCredentials;
  readonly destinationExternalId?: string;
  /** Scopes actually granted, which narrow effective capability. */
  readonly grantedScopes?: readonly string[];
  /** Provider's account classification, which also narrows it. */
  readonly accountType?: string | null;
}

export interface ProviderErrorContext {
  readonly operation: string;
  readonly provider: ProviderName;
}
