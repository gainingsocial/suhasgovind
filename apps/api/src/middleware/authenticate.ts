import type { ApiScope } from '@gs/contracts/scopes';
import { fromPublicId } from '@gs/contracts/ids';
import {
  authenticateApiKey,
  principalFromSession,
  requireScopes,
  verifyDashboardSession,
} from '@gs/auth';
import { createApiKeyRepository, findMembershipForEnvironment } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Authentication for every non-public route (plan §38, §39, P5).
 *
 * Accepts either credential, and resolves both to the same `AuthenticatedPrincipal` so no
 * route has to know which arrived:
 *
 *   `sk_test_…` / `sk_live_…`   a machine. Scopes come from the key's grant.
 *   a Supabase session JWT      a person. Scopes come from their organization role,
 *                               and the environment comes from the `X-GS-Environment`
 *                               header, checked against their membership.
 *
 * The dashboard uses the session path so it never has to store a long-lived API key in a
 * browser, where an XSS bug would turn a stolen session into permanent access (P15).
 *
 * Whichever path runs, the tenant is resolved server-side from the credential and never
 * from the request body or path (P5). A caller cannot name the tenant it wishes to be.
 *
 * Requires `withDatabase()` to have run first — it uses that request's connection.
 */
export function authenticate(requiredScopes: readonly ApiScope[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = c.get('db');
    if (!db) {
      throw new ApiError('INTERNAL_ERROR', {
        message: 'authenticate() requires withDatabase() to run first.',
      });
    }

    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError('AUTHENTICATION_REQUIRED', {
        message: 'An API key is required. Send it as `Authorization: Bearer sk_live_...`.',
      });
    }

    const token = header.slice('Bearer '.length).trim();

    /**
     * Route by shape, and refuse anything that is neither.
     *
     * A JWT is three dot-separated segments; an API key starts with a known prefix.
     * Treating "everything that is not a key" as a session would report a random string
     * as a malformed session, sending an integrator who fat-fingered their key off to
     * debug the wrong subsystem entirely.
     */
    const isApiKey = token.startsWith('sk_test_') || token.startsWith('sk_live_');
    const looksLikeJwt = token.split('.').length === 3;

    if (!isApiKey && !looksLikeJwt) {
      throw new ApiError('API_KEY_MALFORMED');
    }

    const principal = isApiKey
      ? await authenticateWithApiKey(c, token)
      : await authenticateWithSession(c, token);

    // Checked immediately after authentication, so a credential that could never perform
    // the operation is rejected before the route does any work.
    requireScopes(principal, requiredScopes);

    c.set('principal', principal);
    c.set(
      'logger',
      c.get('logger').child(
        {},
        {
          organizationId: principal.organizationId,
          projectId: principal.projectId,
          environmentId: principal.projectEnvironmentId,
          apiKeyId: principal.apiKeyId,
          environment: principal.environment,
        },
      ),
    );

    await next();
  };
}

async function authenticateWithApiKey(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  token: string,
) {
  if (!c.env.API_KEY_HASH_PEPPER) {
    // Rule 14 — a deployment fault, not a caller fault.
    throw new ApiError('INTERNAL_ERROR', {
      message: 'API key authentication is not configured: API_KEY_HASH_PEPPER is unset.',
    });
  }

  return authenticateApiKey(`Bearer ${token}`, {
    repository: createApiKeyRepository(c.get('db')),
    pepper: c.env.API_KEY_HASH_PEPPER,
    // `last_used_at` is telemetry; waitUntil keeps it off the response path (§90).
    defer: (work) => c.executionCtx.waitUntil(work),
  });
}

async function authenticateWithSession(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  token: string,
) {
  if (!c.env.SUPABASE_URL) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'Dashboard authentication is not configured: SUPABASE_URL is unset.',
    });
  }

  const user = await verifyDashboardSession(token, { supabaseUrl: c.env.SUPABASE_URL });

  // A person belongs to potentially several environments, so which one this request acts
  // on has to be stated. It is then checked against membership — the header selects, it
  // does not authorize.
  const requested = c.req.header('x-gs-environment');
  if (!requested) {
    throw new ApiError('INVALID_REQUEST', {
      message: 'Send `X-GS-Environment` with the environment id this request acts on.',
    });
  }

  const environmentId = fromPublicId('environment', requested);
  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`X-GS-Environment` is not a valid environment id.',
    });
  }

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) {
    // Not a member, or the environment does not exist. Both are refused identically so
    // probing cannot distinguish them.
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'You are not a member of that environment.',
    });
  }

  c.set('user', user);

  return principalFromSession({
    // Synthetic, so an audit record can tell a dashboard action from an integration's.
    apiKeyId: `session:${user.userId}`,
    organizationId: membership.organizationId,
    projectId: membership.projectId,
    projectEnvironmentId: membership.projectEnvironmentId,
    environment: membership.environment,
    role: membership.role,
  });
}
