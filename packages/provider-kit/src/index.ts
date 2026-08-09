/**
 * `@gs/provider-kit` — everything needed to write a provider adapter, and nothing that
 * knows about a specific provider.
 *
 * An adapter package depends on this, `@gs/contracts` and `@gs/errors`, and nothing else
 * (plan §75, enforced by `pnpm boundaries`). It may not reach the database, the
 * application layer or the UI: an adapter is a leaf.
 */
export type {
  ProviderAdapterFactory,
  SocialProviderAdapter,
} from './adapter.js';

export * from './types.js';

export {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  parseRetryAfter,
  providerFetch,
  ProviderTimeoutError,
  ProviderTransportError,
  type ProviderRequestInit,
  type ProviderResponse,
} from './http.js';

export {
  accountTypeRestriction,
  approvalRestriction,
  buildCapabilities,
  hasScopes,
  restrictCapabilities,
  scopeRestriction,
  type BuildCapabilitiesInput,
} from './capabilities.js';

export * as findings from './findings.js';
