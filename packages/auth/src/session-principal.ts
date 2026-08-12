import { API_SCOPES, type ApiScope } from '@gs/contracts/scopes';

import type { AuthenticatedPrincipal } from './principal.js';

/**
 * Derive an API principal from a human's organization role (plan §39, P15).
 *
 * The dashboard is an API client and consumes the same routes an external integrator
 * does. The alternative — minting a long-lived API key and keeping it in the browser —
 * would put a credential that outlives the session into local storage, where an XSS bug
 * turns a stolen session into permanent access.
 *
 * So a signed-in person is converted into a principal for the duration of the request.
 * The key facts stay true: the scopes come from the person's role, and the tenant comes
 * from the membership row, never from the request.
 */

/**
 * Role to scope mapping (plan §8.1 roles).
 *
 * Deliberately not "owners get everything". `webhooks:manage` is withheld from marketers
 * because a webhook endpoint is infrastructure — a wrong URL silently sends another
 * system's data somewhere — and `analytics:read` is granted widely because reading
 * numbers harms nothing.
 */
const ROLE_SCOPES: Record<string, readonly ApiScope[]> = {
  owner: API_SCOPES,
  admin: API_SCOPES,
  developer: API_SCOPES,
  marketer: [
    'profiles:read',
    'connections:read',
    'destinations:read',
    'media:read',
    'media:write',
    'posts:read',
    'posts:write',
    'capabilities:read',
    'analytics:read',
    'inbox:read',
    'inbox:write',
  ],
  analyst: ['profiles:read', 'connections:read', 'destinations:read', 'posts:read', 'analytics:read'],
  billing: ['profiles:read'],
  viewer: ['profiles:read', 'connections:read', 'destinations:read', 'posts:read', 'media:read'],
};

export function scopesForRole(role: string): readonly ApiScope[] {
  // An unrecognized role gets nothing rather than a default. A role added to the database
  // but not here should fail closed — the alternative is a new role silently inheriting
  // whatever the fallback happens to be.
  return ROLE_SCOPES[role] ?? [];
}

export interface SessionPrincipalInput {
  apiKeyId: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  environment: 'test' | 'live';
  /** Environment execution mode (plan §49). Defaults to live for callers that omit it. */
  simulationMode?: boolean;
  role: string;
}

/**
 * Build a request-scoped principal for a signed-in person.
 *
 * `apiKeyId` carries a synthetic identifier rather than a real key id, so audit records
 * can tell a dashboard action apart from an integration's. A real key id here would
 * attribute a human's action to a credential that never made it.
 */
export function principalFromSession(input: SessionPrincipalInput): AuthenticatedPrincipal {
  return {
    apiKeyId: input.apiKeyId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    projectEnvironmentId: input.projectEnvironmentId,
    environment: input.environment,
    simulationMode: input.simulationMode ?? false,
    scopes: scopesForRole(input.role),
    // A human is never profile-restricted; that constraint belongs to issued keys.
    restrictedToProfileId: null,
  };
}
