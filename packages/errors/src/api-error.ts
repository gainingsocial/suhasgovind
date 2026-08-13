import { ERROR_CODE_METADATA } from './catalog.js';
import type { ErrorCode } from './codes.js';
import type { ErrorEnvelope, ErrorType, FieldIssue, SanitizedProviderError, SuggestedAction } from './types.js';

/**
 * Where `docs_url` points.
 *
 * This was `docs.gainingsocial.com`, a hostname that has never resolved — so the most
 * useful field in a failure response was a dead link on every error we have ever returned.
 * The reference now lives on the marketing site, where a page is generated per code from
 * this same catalog, so the link a caller follows cannot describe a status or a
 * retryability the API does not actually return.
 */
const DEFAULT_DOCS_BASE = 'https://gainingsocial.com/docs/errors';

export interface ApiErrorOptions {
  /** Overrides the catalog default message. Human-readable only — agents use `code`. */
  message?: string;
  param?: string;
  provider?: string;
  destinationId?: string;
  postId?: string;
  targetId?: string;
  /** Overrides the catalog default. Set explicitly when the occurrence differs from the code default. */
  retryable?: boolean;
  /** UTC ISO-8601. Only meaningful when retryable. */
  retryAfter?: string;
  agentAction?: string;
  suggestedActions?: SuggestedAction[];
  providerError?: SanitizedProviderError;
  details?: FieldIssue[];
  /** Overrides the catalog default HTTP status. */
  status?: number;
  /** Underlying cause, kept for logs. Never serialized into the envelope. */
  cause?: unknown;
}

/**
 * The one error type the API layer throws. Route handlers throw `ApiError`; a single
 * middleware serializes it into the envelope defined in plan §16.
 *
 * Anything that is not an `ApiError` reaching that middleware is a bug and is reported
 * as `INTERNAL_ERROR` with its detail withheld from the client.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly type: ErrorType;
  readonly status: number;
  readonly retryable: boolean;
  readonly param?: string;
  readonly provider?: string;
  readonly destinationId?: string;
  readonly postId?: string;
  readonly targetId?: string;
  readonly retryAfter?: string;
  readonly agentAction?: string;
  readonly suggestedActions?: SuggestedAction[];
  readonly providerError?: SanitizedProviderError;
  readonly details?: FieldIssue[];

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    const meta = ERROR_CODE_METADATA[code];
    super(options.message ?? meta.message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = 'ApiError';
    this.code = code;
    this.type = meta.type;
    this.status = options.status ?? meta.status;
    this.retryable = options.retryable ?? meta.retryable;
    this.param = options.param;
    this.provider = options.provider;
    this.destinationId = options.destinationId;
    this.postId = options.postId;
    this.targetId = options.targetId;
    this.retryAfter = options.retryAfter;
    this.agentAction = options.agentAction ?? meta.agentAction;
    this.suggestedActions = options.suggestedActions;
    this.providerError = options.providerError;
    this.details = options.details;
  }

  /**
   * Serialize to the public envelope. `requestId` and `trace_id` are always present so a
   * customer can quote one identifier and we can find the whole story (plan §40).
   */
  toEnvelope(context: { requestId: string; traceId: string; docsBase?: string }): ErrorEnvelope {
    const docsBase = context.docsBase ?? DEFAULT_DOCS_BASE;
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
        ...(this.provider ? { provider: this.provider } : {}),
        ...(this.destinationId ? { destination_id: this.destinationId } : {}),
        ...(this.postId ? { post_id: this.postId } : {}),
        ...(this.targetId ? { target_id: this.targetId } : {}),
        retryable: this.retryable,
        ...(this.retryAfter ? { retry_after: this.retryAfter } : {}),
        ...(this.agentAction ? { agent_action: this.agentAction } : {}),
        ...(this.suggestedActions?.length ? { suggested_actions: this.suggestedActions } : {}),
        docs_url: `${docsBase}/${this.code}`,
        ...(this.providerError ? { provider_error: this.providerError } : {}),
        ...(this.details?.length ? { details: this.details } : {}),
        request_id: context.requestId,
        trace_id: context.traceId,
      },
    };
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }

  /**
   * Wrap an unknown throwable. Detail from an unrecognized error is deliberately NOT
   * surfaced to the caller — it may contain credentials or internal topology (plan §7.2).
   */
  static from(value: unknown): ApiError {
    if (ApiError.is(value)) return value;
    return new ApiError('INTERNAL_ERROR', { cause: value });
  }
}

/** Convenience constructors for the codes thrown most often. */
export const errors = {
  invalidRequest: (message: string, param?: string, details?: FieldIssue[]) =>
    new ApiError('INVALID_REQUEST', { message, param, details }),

  notFound: (code: Extract<ErrorCode, `${string}NOT_FOUND`>, id?: string) =>
    new ApiError(code, id ? { message: `${ERROR_CODE_METADATA[code].message} (${id})` } : {}),

  /**
   * Ownership failure. Deliberately returns 404 semantics at the route layer for
   * cross-tenant reads so a caller cannot probe for the existence of another tenant's
   * resources; use `TENANT_FORBIDDEN` only when the resource is already known to the caller.
   */
  forbidden: (message?: string) => new ApiError('TENANT_FORBIDDEN', message ? { message } : {}),

  insufficientScope: (required: string) =>
    new ApiError('INSUFFICIENT_SCOPE', {
      message: `This API key is missing the required scope \`${required}\`.`,
      suggestedActions: [{ action: 'request_key_with_required_scope', params: { scope: required } }],
    }),

  rateLimited: (retryAfter: string) => new ApiError('RATE_LIMITED', { retryAfter }),

  internal: (cause?: unknown) => new ApiError('INTERNAL_ERROR', { cause }),
};
