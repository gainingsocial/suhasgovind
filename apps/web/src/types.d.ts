/**
 * Ambient declarations for the dashboard.
 *
 * The repo-wide tsconfig pins `types` to the Workers runtime and this package overrides it
 * for the browser, which means Next's own ambient CSS declarations are not picked up
 * automatically. Declaring the side-effect import here is narrower than widening `types`
 * for the whole package.
 */
declare module '*.css';
