import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AuthStrategy, ProviderName } from '@gs/contracts/providers';
import type { AdapterValidationResult } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';

import type {
  AuthCallbackInput,
  AuthRedirect,
  AuthResult,
  CapabilityContext,
  ConnectionIdentity,
  CreateAuthorizationInput,
  DeletePublishedPostInput,
  DeleteResult,
  InspectCredentialInput,
  ListDestinationsInput,
  PrepareTargetInput,
  PreparedPublish,
  ProviderDestination,
  ProviderErrorContext,
  ProviderWebhookRequest,
  ProviderWebhookResult,
  PublishResult,
  PublishStatusInput,
  PublishStatusResult,
  PublishTargetInput,
  ReconcileInput,
  ReconcileResult,
  RefreshCredentialInput,
  RefreshResult,
  RevokeCredentialInput,
  ValidateTargetInput,
} from './types.js';

/**
 * The one interface every provider implements (plan §19).
 *
 * The core resolves adapters through the `@gs/providers` registry and never imports a
 * concrete adapter (plan P1, enforced by `pnpm boundaries`). That is what allows a
 * provider to be added without touching the publishing engine, and what stops a Meta
 * quirk leaking into how LinkedIn is retried.
 *
 * Strict rule (plan §19): no route handler, worker or workflow imports a provider SDK.
 * All provider interaction passes through here.
 */
export interface SocialProviderAdapter {
  readonly provider: ProviderName;
  /**
   * Adapter version, independent of the provider's own API version (plan §44).
   * Recorded on every attempt so a behaviour change is attributable after the fact.
   */
  readonly version: string;
  /** Drives the connect flow (plan §20). */
  readonly authStrategy: AuthStrategy;
  /**
   * Provider API version this adapter targets, when the platform versions its API
   * (plan §44). `null` for unversioned platforms.
   */
  readonly providerApiVersion: string | null;

  /**
   * Generic capability with no context; effective capability when given credentials and
   * a destination (plan §17). The difference is load-bearing — see the schema docs.
   */
  capabilities(context?: CapabilityContext): Promise<ProviderCapabilities>;

  readonly auth: {
    createAuthorization(input: CreateAuthorizationInput): Promise<AuthRedirect>;
    exchangeCallback(input: AuthCallbackInput): Promise<AuthResult>;
    refresh(input: RefreshCredentialInput): Promise<RefreshResult>;
    revoke(input: RevokeCredentialInput): Promise<void>;
    inspect(input: InspectCredentialInput): Promise<ConnectionIdentity>;
  };

  readonly destinations: {
    list(input: ListDestinationsInput): Promise<ProviderDestination[]>;
  };

  readonly publishing: {
    /**
     * Pure validation. MUST NOT perform a publish side effect (plan §18) — this runs on
     * `POST /v1/posts/preflight`, which callers are encouraged to hit freely.
     */
    validate(input: ValidateTargetInput): Promise<AdapterValidationResult>;
    /** Uploads media, opens containers. Side-effecting but not yet published. */
    prepare(input: PrepareTargetInput): Promise<PreparedPublish>;
    publish(input: PublishTargetInput): Promise<PublishResult>;
    /** Required only where the provider processes asynchronously. */
    status?(input: PublishStatusInput): Promise<PublishStatusResult>;
    /**
     * Required for certification unless the platform genuinely offers no way to search
     * recent posts (plan §65). Without it, an ambiguous timeout can only ever escalate
     * to a human, because retrying blindly risks a duplicate.
     */
    findPossibleDuplicate?(input: ReconcileInput): Promise<ReconcileResult>;
    delete?(input: DeletePublishedPostInput): Promise<DeleteResult>;
  };

  /**
   * Map any upstream failure onto the shared taxonomy (plan §79).
   *
   * The engine branches on the normalized code and never on a provider's own error
   * strings — that is what keeps retry policy provider-agnostic. An unrecognized error
   * maps to `UNKNOWN_PROVIDER_ERROR`, which is deliberately NOT auto-retried (Rule 14).
   */
  normalizeError(error: unknown, context: ProviderErrorContext): NormalizedProviderError;

  /**
   * Present only for providers that deliver webhooks (plan §34).
   *
   * Must be pure and fast: verify the signature, carve the batch into normalized events,
   * return. No network calls and no side effects — the ingress acknowledges before any
   * processing happens, and anything slow here eats into the provider's ack deadline.
   */
  verifyWebhook?(request: ProviderWebhookRequest): Promise<ProviderWebhookResult>;
}

/**
 * Adapter construction is deferred behind a factory so the registry can list providers,
 * and the dashboard can render them, without constructing anything. Some adapters will
 * want per-call configuration later; a factory leaves room for that without changing the
 * registry's shape.
 */
export type ProviderAdapterFactory = () => SocialProviderAdapter;
