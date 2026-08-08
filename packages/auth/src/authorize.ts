import type { ApiScope } from '@gs/contracts/scopes';
import { ApiError } from '@gs/errors';

import type { AuthenticatedPrincipal, ResourceOwnership } from './principal.js';

/**
 * Authorization, in two independent checks that a route must pass both of:
 *
 *   requireScopes      — is this key allowed to perform this KIND of operation?
 *   assertOwnership    — does this SPECIFIC resource belong to this key's tenant?
 *
 * They are separate because they fail for different reasons and neither implies the
 * other. A key with `posts:write` may still not touch another tenant's post, and a key
 * that owns a post may still lack the scope to publish it.
 */

/** Every scope must be present. Missing ones are named so the caller can fix the grant. */
export function requireScopes(
  principal: AuthenticatedPrincipal,
  required: readonly ApiScope[],
): void {
  const missing = required.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length === 0) return;

  throw new ApiError('INSUFFICIENT_SCOPE', {
    message:
      `This API key is missing the ${missing.map((s) => `\`${s}\``).join(', ')} ` +
      `scope${missing.length > 1 ? 's' : ''}.`,
  });
}

/**
 * Verify a resource belongs to the authenticated tenant (plan P5, §10.3).
 *
 * The caller resolves the full chain — `destination -> connection -> profile ->
 * environment -> project` — and passes the result here. That resolution must come from
 * the database, never from the request: a caller that could assert its own project id
 * would be authorizing itself.
 *
 * `TENANT_FORBIDDEN` is returned rather than a 404, deliberately. Both leak the same
 * single bit (the id exists), and a distinct code lets a customer with a genuine
 * cross-project mistake understand what went wrong instead of hunting a phantom 404.
 */
export function assertOwnership(
  principal: AuthenticatedPrincipal,
  resource: ResourceOwnership,
): void {
  // Environment is checked first and is the tightest of the three: it pins test/live as
  // well as the project, so a match here cannot be satisfied by a sibling environment.
  const mismatch =
    resource.projectEnvironmentId !== principal.projectEnvironmentId ||
    resource.projectId !== principal.projectId ||
    resource.organizationId !== principal.organizationId;

  if (mismatch) {
    throw new ApiError('TENANT_FORBIDDEN');
  }

  // A profile-restricted key may only touch resources on that profile (plan §38).
  if (
    principal.restrictedToProfileId !== null &&
    resource.profileId != null &&
    resource.profileId !== principal.restrictedToProfileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }
}

/** Convenience for routes that need both checks, in the order that fails cheapest first. */
export function authorize(
  principal: AuthenticatedPrincipal,
  required: readonly ApiScope[],
  resource?: ResourceOwnership,
): void {
  requireScopes(principal, required);
  if (resource) assertOwnership(principal, resource);
}
