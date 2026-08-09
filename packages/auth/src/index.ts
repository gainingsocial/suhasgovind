export type { AuthenticatedPrincipal, ResourceOwnership } from './principal.js';
export type { ApiKeyRecord, ApiKeyRepository } from './ports.js';
export type { AuthenticateOptions } from './authenticate.js';
export { authenticateApiKey, extractBearerToken } from './authenticate.js';
export { assertOwnership, authorize, requireScopes } from './authorize.js';

export type { DashboardUser } from './dashboard-session.js';
export { clearJwksCache, verifyDashboardSession } from './dashboard-session.js';
