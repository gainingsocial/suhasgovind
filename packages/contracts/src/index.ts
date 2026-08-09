/**
 * Public surface of `@gs/contracts`.
 *
 * The package.json `.` export already pointed here; the file itself was missing, so any
 * bare `@gs/contracts` import would have failed to resolve. Subpath exports such as
 * `@gs/contracts/ids` keep working independently of this barrel.
 */
export * from './common/ids.js';
export * from './common/pagination.js';
export * from './common/providers.js';
export * from './common/scopes.js';
export * from './http/index.js';
export * from './providers/index.js';
