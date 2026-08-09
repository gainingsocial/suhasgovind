import type { ApiScope } from '@gs/contracts/scopes';
import { authenticateApiKey, requireScopes } from '@gs/auth';
import { createApiKeyRepository } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Bearer authentication for every non-public route (plan §38, P5).
 *
 * The principal is derived entirely from the presented key. Nothing about the tenant is
 * read from the path, the body or a header, so a caller cannot name the tenant it wishes
 * to be.
 *
 * Requires `withDatabase()` to have run first — it uses that request's connection rather
 * than opening its own.
 */
export function authenticate(requiredScopes: readonly ApiScope[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.env.API_KEY_HASH_PEPPER) {
      // Rule 14 — a deployment fault, not a caller fault. Saying so precisely beats
      // failing somewhere deeper with a confusing error.
      throw new ApiError('INTERNAL_ERROR', {
        message: 'API key authentication is not configured: API_KEY_HASH_PEPPER is unset.',
      });
    }

    const db = c.get('db');
    if (!db) {
      throw new ApiError('INTERNAL_ERROR', {
        message: 'authenticate() requires withDatabase() to run first.',
      });
    }

    const principal = await authenticateApiKey(c.req.header('authorization'), {
      repository: createApiKeyRepository(db),
      pepper: c.env.API_KEY_HASH_PEPPER,
      // `last_used_at` is telemetry; waitUntil keeps it off the response path (§90).
      defer: (work) => c.executionCtx.waitUntil(work),
    });

    // Checked immediately after authentication, so a key that could never perform the
    // operation is rejected before the route does any work.
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
  };
}
