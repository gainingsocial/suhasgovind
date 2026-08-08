import type { ApiScope } from '@gs/contracts/scopes';

/**
 * Who is making the request, and what they may touch.
 *
 * Everything here is derived server-side from the presented key (P5). Nothing is taken
 * from a header, a body field or a path parameter — a caller cannot name the tenant it
 * wants to act as, it can only present a key and be told.
 */
export interface AuthenticatedPrincipal {
  apiKeyId: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  /**
   * Which side of the test/live split this key acts on. It is a property of the key, so
   * a test key can never reach live data even if it names a live resource.
   */
  environment: 'test' | 'live';
  scopes: readonly ApiScope[];
  /**
   * Set when the key is restricted to a single profile (plan §38). `null` means the key
   * may act on any profile within its environment.
   */
  restrictedToProfileId: string | null;
}

/** The tenancy chain a resource must resolve to before it may be touched (plan §10.3). */
export interface ResourceOwnership {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  /** Present for resources that hang off a profile; absent for project-level ones. */
  profileId?: string | null;
}
