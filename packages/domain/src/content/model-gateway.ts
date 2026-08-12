import type { ModelCallPolicy } from './untrusted-source.js';

/**
 * The model gateway port (plan §4.2, §63R).
 *
 * Provider-neutral by design. Everything above this interface — extraction, generation,
 * classification — is written against it, and swapping the model behind it changes one
 * adapter rather than the pipeline.
 *
 * This is a **port, not an implementation**. The concrete adapter needs an API key the
 * platform operator supplies, and until one exists the content pipeline reports that it is
 * unconfigured rather than silently producing nothing (Rule 14). Everything that does not
 * need a model — ingestion, sanitization, span splitting, grounding verification, the
 * whole publishing engine — works regardless (plan P19: AI is optional around publishing).
 */

export interface ModelRequest {
  /** Which step is asking. Recorded on every run, so cost is attributable (plan §63R). */
  readonly purpose: 'extraction' | 'generation' | 'classification';
  /**
   * Instructions. Never contains source text — that goes in `untrustedContent`, wrapped,
   * where a model reads it as data (plan §63S rule 1).
   */
  readonly instructions: string;
  /** Already sanitized and wrapped. The gateway does not wrap it again. */
  readonly untrustedContent: string;
  /**
   * The shape the response must take. Validated after the call, because a model asked for
   * JSON returns prose often enough that trusting it is a choice (plan §63R).
   */
  readonly schema: unknown;
  readonly policy: ModelCallPolicy;
  /** Version string, so an output change is attributable to a prompt change. */
  readonly promptVersion: string;
  readonly signal?: AbortSignal;
}

export interface ModelResponse {
  /** Parsed and schema-validated. A response that failed validation never reaches here. */
  readonly output: unknown;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
}

/**
 * Why a model call failed, in terms the pipeline can act on.
 *
 * Mirrors the provider error taxonomy (plan §79) for the same reason: the caller branches
 * on the code, so a gateway swap must not change how a timeout is handled.
 */
export type ModelErrorCode =
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CONTEXT_TOO_LARGE'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'CONTENT_FILTERED'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

export class ModelGatewayError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;

  constructor(code: ModelErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ModelGatewayError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ModelGateway {
  readonly configured: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * The gateway used when no model provider is configured.
 *
 * Fails loudly with a code the caller can branch on, rather than returning empty output
 * that would look like a source with nothing worth saying. Rule 14: when uncertain, fail
 * safely with a useful error rather than guessing.
 *
 * Deliberately not a stub that returns plausible text. A fake extraction would flow through
 * grounding verification, fail it, and surface as "this article could not be grounded" —
 * blaming the source for a missing API key.
 */
export const UNCONFIGURED_GATEWAY: ModelGateway = {
  configured: false,
  complete() {
    return Promise.reject(
      new ModelGatewayError(
        'NOT_CONFIGURED',
        'No model provider is configured. Content Intelligence needs one; publishing does not.',
      ),
    );
  },
};

/**
 * Cache key for an extraction (plan §63R: "do not repeatedly analyze unchanged content").
 *
 * Covers the content hash, the prompt version and the model. All three matter: the same
 * text under a new prompt is a different extraction, and under a different model it is a
 * different extraction again. Keying on content alone would serve a stale result forever
 * after a prompt improvement.
 */
export function extractionCacheKey(input: {
  contentHash: string;
  promptVersion: string;
  model: string;
}): string {
  return `${input.model}|${input.promptVersion}|${input.contentHash}`;
}
