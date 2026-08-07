export type { ErrorCode } from './codes.js';
export { ERROR_CODES, isKnownErrorCode } from './codes.js';

export type { ErrorCodeMetadata } from './catalog.js';
export { ERROR_CODE_METADATA } from './catalog.js';

export type {
  ErrorEnvelope,
  ErrorType,
  FieldIssue,
  SanitizedProviderError,
  SuggestedAction,
} from './types.js';

export type { ApiErrorOptions } from './api-error.js';
export { ApiError, errors } from './api-error.js';

export type {
  ErrorSeverity,
  NormalizedProviderError,
  ProviderErrorCode,
  ProviderErrorMetadata,
  PublishDisposition,
  RetryStrategy,
} from './provider-taxonomy.js';
export {
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_METADATA,
  dispositionFor,
  isRetryable,
  providerErrorMetadata,
} from './provider-taxonomy.js';

export { providerErrorToApiError } from './bridge.js';
