/**
 * The agent-native error envelope (plan §16).
 *
 * Design rule: never force an LLM to parse an English sentence to decide what to do.
 * `code` is stable and documented, `retryable` is explicit, and `agent_action` /
 * `suggested_actions` are machine-useful.
 */

/** Coarse error family. Maps to an HTTP status class. */
export type ErrorType =
  | 'validation_error'
  | 'authentication_error'
  | 'authorization_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'idempotency_error'
  | 'rate_limit_error'
  | 'provider_error'
  | 'connection_error'
  | 'media_error'
  | 'api_error';

/**
 * A structured next step an agent (or SDK) can execute without natural-language parsing.
 * `action` names an operation in the dynamic action schema (plan §96).
 */
export interface SuggestedAction {
  action: string;
  params?: Record<string, unknown>;
  /** Human-readable rationale. Optional and never required for machine use. */
  reason?: string;
}

/**
 * The sanitized shape of an upstream provider failure. Raw provider bodies are never
 * passed through: they leak tokens, internal IDs and unstable strings (plan §7.2, §16).
 */
export interface SanitizedProviderError {
  /** Our normalized taxonomy code (plan §79). */
  code: string;
  /** Provider's own stable subcode, when it publishes one. */
  subcode?: string;
  /** Provider HTTP status, when the failure was an HTTP response. */
  status?: number;
}

/** The body of every non-2xx response from the public API. */
export interface ErrorEnvelope {
  error: {
    type: ErrorType;
    code: string;
    message: string;
    /** Dotted path into the request body, e.g. `content.media_ids[0]`. */
    param?: string;
    provider?: string;
    destination_id?: string;
    post_id?: string;
    target_id?: string;
    retryable: boolean;
    /** When `retryable`, the earliest sensible retry time (UTC ISO-8601). */
    retry_after?: string;
    /** Single canonical next step for an agent. */
    agent_action?: string;
    /** Zero or more executable next steps. */
    suggested_actions?: SuggestedAction[];
    docs_url?: string;
    provider_error?: SanitizedProviderError;
    request_id: string;
    trace_id: string;
    /** Present on preflight/validation failures that concern several fields. */
    details?: FieldIssue[];
  };
}

/** One field-level problem, used when a single `param` cannot express the failure. */
export interface FieldIssue {
  code: string;
  message: string;
  param?: string;
  destination_id?: string;
  provider?: string;
}
