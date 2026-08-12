import type { ErrorEnvelopeShape } from '@gs/contracts/http';

/**
 * The one error type the SDK throws (plan §16, §40).
 *
 * Everything the API's error envelope carries is a property here, so a caller never has
 * to parse a message or reach into a response body. `code` is the stable, documented
 * discriminator — branch on it, never on `message`, which is prose and may be reworded.
 *
 * `retryable` deserves particular attention: the API computes it from the error taxonomy,
 * which knows things a client cannot infer. A 409 from an in-progress idempotent request
 * is retryable; a 409 from a duplicate-content refusal is not.
 */
export class GainingSocialError extends Error {
  /** HTTP status. 0 when the request never reached the API. */
  readonly status: number;
  /** Broad category, e.g. `authentication_error`. */
  readonly type: string;
  /** Stable, documented, SCREAMING_SNAKE_CASE. This is what to branch on. */
  readonly code: string;
  /** Whether retrying the identical request could succeed. */
  readonly retryable: boolean;
  readonly docsUrl: string;
  /** Quote this to support; it identifies the exact request. */
  readonly requestId: string;
  readonly traceId: string;

  readonly param: string | undefined;
  readonly provider: string | undefined;
  readonly destinationId: string | undefined;
  readonly postId: string | undefined;
  readonly targetId: string | undefined;
  /** UTC ISO-8601, when the provider told us when to come back. */
  readonly retryAfter: string | undefined;
  /** Machine-readable next step for an autonomous caller (plan §51). */
  readonly agentAction: string | undefined;
  readonly suggestedActions: { kind: string; description: string; href?: string }[] | undefined;
  /** Per-field detail on a validation failure. */
  readonly details: { path: string; message: string; code?: string }[] | undefined;

  constructor(status: number, body: ErrorEnvelopeShape['error']) {
    super(body.message);
    this.name = 'GainingSocialError';
    this.status = status;
    this.type = body.type;
    this.code = body.code;
    this.retryable = body.retryable;
    this.docsUrl = body.docs_url;
    this.requestId = body.request_id;
    this.traceId = body.trace_id;
    this.param = body.param;
    this.provider = body.provider;
    this.destinationId = body.destination_id;
    this.postId = body.post_id;
    this.targetId = body.target_id;
    this.retryAfter = body.retry_after;
    this.agentAction = body.agent_action;
    this.suggestedActions = body.suggested_actions;
    this.details = body.details;
  }

  /**
   * Build an error for a failure that never produced an envelope — DNS, TLS, a timeout, a
   * proxy returning HTML.
   *
   * Deliberately marked retryable: a request that never reached the API cannot have had a
   * side effect, so trying again is safe. That is the opposite of the rule the server side
   * follows for provider calls, and for the same underlying reason — what matters is
   * whether the side effect might already have happened.
   */
  static transport(message: string, cause?: unknown): GainingSocialError {
    const error = new GainingSocialError(0, {
      type: 'connection_error',
      code: 'CONNECTION_FAILED',
      message,
      retryable: true,
      docs_url: 'https://docs.gainingsocial.com/errors/CONNECTION_FAILED',
      request_id: '',
      trace_id: '',
    });
    error.cause = cause;
    return error;
  }

  /** A response the SDK could not read as an error envelope. */
  static malformed(status: number, body: string): GainingSocialError {
    return new GainingSocialError(status, {
      type: 'api_error',
      code: 'UNEXPECTED_RESPONSE',
      message:
        `The API returned ${status} with a body the SDK could not read as an error. ` +
        `First 200 characters: ${body.slice(0, 200)}`,
      // A 5xx is worth another attempt; a 4xx that is not an envelope will not change.
      retryable: status >= 500,
      docs_url: 'https://docs.gainingsocial.com/errors/UNEXPECTED_RESPONSE',
      request_id: '',
      trace_id: '',
    });
  }
}

/** Narrowing helper, so a caller does not need `instanceof` across module boundaries. */
export function isGainingSocialError(error: unknown): error is GainingSocialError {
  return error instanceof GainingSocialError;
}
