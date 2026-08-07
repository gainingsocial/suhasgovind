/**
 * Architectural boundary enforcement — plan §75 "Architectural Dependency Rule".
 *
 * Allowed direction:
 *   route -> application service -> domain -> repository interface -> db impl
 *   application service -> provider adapter interface -> provider implementation
 *
 * Run with: pnpm boundaries
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make the layering unverifiable.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts)$',
        ],
      },
      to: {},
    },

    // ---- P1 / §75: no provider-specific code outside packages/providers ----
    {
      name: 'routes-may-not-import-a-concrete-provider',
      severity: 'error',
      comment:
        'Plan P1/§19: no route handler, worker or workflow may import a concrete provider package. ' +
        'Resolve adapters through the @gs/providers registry so the core stays provider-agnostic.',
      from: { path: '^(apps|workers|workflows)/' },
      to: { path: '^packages/providers/(?!registry)[^/]+/' },
    },
    {
      name: 'core-may-not-import-provider-sdks',
      severity: 'error',
      comment:
        'Plan §19 strict rule: Meta/LinkedIn/TikTok/AT-Protocol SDKs are only reachable from inside ' +
        'a provider adapter package.',
      from: { path: '^(apps|workers|workflows|packages/(domain|contracts|db|events))/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
        path: '^(@atproto|facebook-nodejs-business-sdk|linkedin-api-client|googleapis|twitter-api-v2)',
      },
    },

    // ---- P11 / §75: the dashboard is an API client, not a database client ----
    {
      name: 'web-may-not-touch-the-database',
      severity: 'error',
      comment:
        'Plan P11/P15/§75: the dashboard consumes the same public contracts as external customers. ' +
        'It must never hold database or admin credentials.',
      from: { path: '^apps/web/' },
      to: { path: '^packages/(db|crypto)/' },
    },

    // ---- §75: queue consumers must go through repositories ----
    {
      name: 'no-raw-sql-driver-outside-db-package',
      severity: 'error',
      comment:
        'Plan §75/§76: workers and routes must use domain-shaped repositories from @gs/db, ' +
        'not an ad-hoc postgres client.',
      from: { path: '^(apps|workers|workflows)/', pathNot: '\\.(test|spec)\\.ts$' },
      to: { dependencyTypes: ['npm'], path: '^(postgres|pg|drizzle-orm)$' },
    },

    // ---- §75: adapters are leaves ----
    {
      name: 'provider-adapter-is-a-leaf',
      severity: 'error',
      comment:
        'Plan §75: a provider adapter may not depend on the UI, the database, billing or the ' +
        'application layer. It depends on @gs/provider-kit, @gs/contracts and @gs/errors only.',
      from: { path: '^packages/providers/(?!registry)' },
      to: { path: '^(apps|workers|workflows|packages/(db|domain|events))/' },
    },

    // ---- dependencies point inward, toward the domain ----
    {
      name: 'domain-must-stay-pure',
      severity: 'error',
      comment:
        'Clean-architecture direction: infrastructure depends on the domain, never the ' +
        'reverse. @gs/db may import @gs/domain (it must enforce domain invariants); ' +
        '@gs/domain may not import @gs/db, a provider, or an app.',
      from: { path: '^packages/domain/' },
      to: { path: '^(apps|workers|workflows|packages/(db|providers))/' },
    },

    // ---- contracts stay dependency-light so SDKs can consume them ----
    {
      name: 'contracts-must-stay-portable',
      severity: 'error',
      comment:
        'Plan §46/§47: @gs/contracts is published as the SDK/OpenAPI source of truth. It may not ' +
        'depend on infrastructure.',
      from: { path: '^packages/contracts/' },
      to: { path: '^packages/(db|providers|domain)/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.ts$|\\.spec\\.ts$|/dist/|/\\.next/|/\\.wrangler/)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
