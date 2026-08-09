import { isProviderName, type ProviderName } from '@gs/contracts/providers';
import { ApiError } from '@gs/errors';
import type { ProviderAdapterFactory, SocialProviderAdapter } from '@gs/provider-kit';
import { createBlueskyAdapter } from '@gs/provider-bluesky';
import { createMockAdapter } from '@gs/provider-mock';
import { createTelegramAdapter } from '@gs/provider-telegram';

/**
 * The adapter registry (plan P1, §19).
 *
 * The only way the core reaches a provider. Route handlers, workers and workflows call
 * `getAdapter(provider)`; none of them may import a concrete adapter package, which
 * `pnpm boundaries` enforces via the `routes-may-not-import-a-concrete-provider` rule.
 *
 * This package is the single exception to that rule — it is where the provider-agnostic
 * core and the provider-specific implementations are allowed to meet.
 *
 * Adding a provider is: implement the adapter, add one line here. Nothing in the
 * publishing engine changes (plan P14, "no rewrite-oriented phases").
 */

/**
 * Factories, not instances. Listing providers for the dashboard or the capabilities
 * endpoint must not construct every adapter, and some adapters will eventually want
 * per-call configuration.
 */
const FACTORIES: Partial<Record<ProviderName, ProviderAdapterFactory>> = {
  mock: createMockAdapter,
  bluesky: createBlueskyAdapter,
  telegram: createTelegramAdapter,
};

/**
 * Cached instances. Adapters are stateless — configuration arrives per call — so one
 * instance per isolate is safe and avoids rebuilding capability documents on every
 * request.
 */
const instances = new Map<ProviderName, SocialProviderAdapter>();

/**
 * Providers with a registered adapter, in the order declared above.
 *
 * Distinct from `PROVIDER_NAMES`, which lists every provider the product intends to
 * support. The difference is exactly the set still to be built, so the dashboard can
 * show "coming soon" without a second hand-maintained list drifting out of date.
 */
export function implementedProviders(): ProviderName[] {
  return Object.keys(FACTORIES).filter(isProviderName);
}

export function hasAdapter(provider: string): provider is ProviderName {
  return isProviderName(provider) && FACTORIES[provider] !== undefined;
}

/**
 * Resolve an adapter.
 *
 * Throws rather than returning null. A caller reaching this point has already resolved a
 * destination that names the provider, so a missing adapter is a deployment fault, not a
 * caller error — and Rule 14 says to fail with a useful message rather than let
 * `undefined` propagate into a publish path.
 */
export function getAdapter(provider: string): SocialProviderAdapter {
  if (!isProviderName(provider)) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', {
      message: `"${provider}" is not a known provider.`,
    });
  }

  const cached = instances.get(provider);
  if (cached) return cached;

  const factory = FACTORIES[provider];
  if (!factory) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', {
      message: `No adapter is registered for "${provider}" yet.`,
    });
  }

  const adapter = factory();

  // A factory returning an adapter that disagrees with its registry key would route
  // publishes to the wrong platform. Cheap to check, catastrophic to miss.
  if (adapter.provider !== provider) {
    throw new Error(
      `Adapter registered as "${provider}" reports provider "${adapter.provider}".`,
    );
  }

  instances.set(provider, adapter);
  return adapter;
}

/** Test seam: drops cached instances so a test can swap an adapter. */
export function resetAdapterCache(): void {
  instances.clear();
}
