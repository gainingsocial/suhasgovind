import type { ApiScope } from '@gs/contracts/scopes';
import { authenticateApiKey, requireScopes } from '@gs/auth';
import { createApiKeyRepository, createDatabaseFromEnv } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Bearer authentication for every non-public route (plan §38, P5).
 *
 * The principal is derived entirely from the presented key. Nothing about the tenant is
 * read from the path, the body or a header, so a caller cannot name the tenant it wishes
 * to be.
 */

/**
 * Rule 14 — when the platform is not configured, say so precisely rather than failing
 * somewhere deeper with a confusing error. These are deployment faults, not caller
 * faults, so they are 5xx and are logged.
 */
function requireConfiguration(env: AppEnv['Bindings']): {
  pepper: string;
} {
  if (!env.API_KEY_HASH_PEPPER) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'API key authentication is not configured: API_KEY_HASH_PEPPER is unset.',
    });
  }
  if (!env.HYPERDRIVE && !env.DATABASE_URL) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'No database binding is configured: bind HYPERDRIVE or set DATABASE_URL.',
    });
  }
  return { pepper: env.API_KEY_HASH_PEPPER };
}

/**
 * @param requiredScopes checked immediately after authentication, so a key that could
 * never perform the operation is rejected before the route does any work.
 */
export function authenticate(requiredScopes: readonly ApiScope[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { pepper } = requireConfiguration(c.env);

    const handle = createDatabaseFromEnv(c.env);
    try {
      const principal = await authenticateApiKey(c.req.header('authorization'), {
        repository: createApiKeyRepository(handle.db),
        pepper,
        // `last_used_at` is telemetry; waitUntil keeps it off the response path (§90).
        defer: (work) => c.executionCtx.waitUntil(work),
      });

      requireScopes(principal, requiredScopes);

      c.set('principal', principal);
      // Bind the tenant onto the logger so every later line is attributable without the
      // route having to remember to pass it.
      c.set(
        'logger',
        c.get('logger').child({
          organizationId: principal.organizationId,
          projectId: principal.projectId,
          environmentId: principal.projectEnvironmentId,
          apiKeyId: principal.apiKeyId,
          environment: principal.environment,
        }),
      );

      await next();
    } finally {
      // The pool belongs to this request. Closing is deferred so any waitUntil work that
      // is still using the connection is not cut off mid-write.
      c.executionCtx.waitUntil(handle.close());
    }
  };
}
