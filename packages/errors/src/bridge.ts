import { ApiError } from './api-error.js';
import type { NormalizedProviderError } from './provider-taxonomy.js';
import { PROVIDER_ERROR_METADATA, isRetryable } from './provider-taxonomy.js';

export interface ProviderErrorContextIds {
  provider: string;
  destinationId?: string;
  postId?: string;
  targetId?: string;
}

/**
 * Translate a normalized provider failure into the public error envelope (plan §16).
 *
 * The provider's own message is deliberately dropped in favour of ours: upstream strings
 * are unstable, occasionally contain internal identifiers, and are written for the
 * provider's developers rather than ours. Only the normalized `code`, an optional stable
 * `subcode` and the HTTP status survive into `provider_error` (plan §16 "raw provider
 * errors are sanitized").
 */
export function providerErrorToApiError(
  error: NormalizedProviderError,
  context: ProviderErrorContextIds,
): ApiError {
  const meta = PROVIDER_ERROR_METADATA[error.code];

  return new ApiError(meta.publicCode, {
    message: meta.userAction,
    provider: context.provider,
    destinationId: context.destinationId,
    postId: context.postId,
    targetId: context.targetId,
    retryable: isRetryable(error),
    retryAfter: error.retryAfter,
    agentAction: meta.agentAction,
    providerError: {
      code: error.code,
      ...(error.subcode ? { subcode: error.subcode } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    },
  });
}
