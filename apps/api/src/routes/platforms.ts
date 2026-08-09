import {
  CapabilitiesResponseSchema,
  PlatformListResponseSchema,
  PlatformSchema,
} from '@gs/contracts/http';
import {
  isProviderName,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_NAMES,
  requiresProviderApp,
} from '@gs/contracts/providers';
import { findDestinationById } from '@gs/db';
import { ApiError } from '@gs/errors';
import { getAdapter, hasAdapter } from '@gs/providers';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { providerCallContext } from '../lib/provider-context.js';
import { requirePathId } from '../lib/request.js';

/**
 * Platform discovery and the capability registry (plan §17, §14).
 *
 * Plan §17 calls this a major product feature rather than documentation, and the reason
 * is agents: an agent that can ask "what is possible here" before composing avoids the
 * compose-submit-reject-guess loop entirely (P16, P17).
 *
 * The two resolutions are genuinely different and must not be conflated:
 *
 *   /v1/platforms/{provider}/capabilities   what the platform can do at all
 *   /v1/destinations/{id}/capabilities      what THIS destination can do, narrowed by
 *                                           granted scopes, account type and approval
 */
export const platforms = new Hono<AppEnv>();
export const destinations = new Hono<AppEnv>();

/**
 * Every provider the product intends to support, with `available` marking which have an
 * adapter today.
 *
 * Listing the unbuilt ones is deliberate: a dashboard can render "coming soon" from the
 * API instead of hard-coding a second list that drifts. It also means an integrator can
 * see the roadmap without reading it.
 *
 * Needs no database, so no `withDatabase()` — but it is authenticated, because the set of
 * supported platforms is commercially interesting.
 */
platforms.get('/', withDatabase(), authenticate(['capabilities:read']), (c) => {
  const data = PROVIDER_NAMES.filter((provider) => provider !== 'mock' || c.env.ENVIRONMENT === 'test').map(
    (provider) => {
      const available = hasAdapter(provider);
      return PlatformSchema.parse({
        provider,
        object: 'platform',
        display_name: PROVIDER_DISPLAY_NAMES[provider],
        // Only an implemented adapter can state its strategy; claiming one for an
        // unbuilt provider would be a guess, and plan Rule 2 forbids guessing.
        auth_strategy: available ? getAdapter(provider).authStrategy : null,
        available,
        requires_provider_app: available ? requiresProviderApp(getAdapter(provider).authStrategy) : true,
      });
    },
  );

  return c.json(
    PlatformListResponseSchema.parse({
      object: 'list',
      data,
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

platforms.get(
  '/:provider/capabilities',
  withDatabase(),
  authenticate(['capabilities:read']),
  async (c) => {
    const provider = c.req.param('provider');

    if (!isProviderName(provider)) {
      throw new ApiError('PROVIDER_NOT_SUPPORTED', {
        message: `"${provider}" is not a known provider.`,
        param: 'provider',
      });
    }

    // Generic capability: no credentials, no destination. Anything account-specific is
    // deliberately absent, and a caller that needs it must ask the destination endpoint.
    const capabilities = await getAdapter(provider).capabilities();
    return c.json(CapabilitiesResponseSchema.parse(capabilities), 200);
  },
);

destinations.get(
  '/:destinationId/capabilities',
  withDatabase(),
  authenticate(['capabilities:read']),
  async (c) => {
    const principal = c.get('principal');
    const destinationId = requirePathId(c, 'destination', 'destinationId');

    const destination = await findDestinationById(
      c.get('db'),
      principal.projectEnvironmentId,
      destinationId,
    );
    if (!destination) throw new ApiError('DESTINATION_NOT_FOUND');

    if (
      principal.restrictedToProfileId !== null &&
      principal.restrictedToProfileId !== destination.profileId
    ) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'This API key is restricted to a different profile.',
      });
    }

    if (!isProviderName(destination.provider)) {
      throw new ApiError('INTERNAL_ERROR', {
        message: `Destination ${destinationId} names unknown provider "${destination.provider}".`,
      });
    }

    // The cached document is served when present. Resolving it live would mean a provider
    // round trip on a read that a composer UI calls constantly — and the cache is
    // refreshed on connect and on every health check, which is when it can actually
    // change.
    if (destination.capabilities) {
      const cached = CapabilitiesResponseSchema.safeParse(destination.capabilities);
      if (cached.success) return c.json(cached.data, 200);
      // A cached document written under an older schema version is re-resolved rather
      // than reinterpreted (plan §80) — misreading it would produce wrong preflight
      // answers silently.
    }

    const adapter = getAdapter(destination.provider);
    const capabilities = await adapter.capabilities({
      context: providerCallContext(c, { timeoutMs: 10_000 }),
      app: null,
      destinationExternalId: destination.providerDestinationId,
    });

    return c.json(CapabilitiesResponseSchema.parse(capabilities), 200);
  },
);
