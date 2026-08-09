import { createTenantHarness, databaseUrl, type TenantHarness } from '@gs/db/test-support';

import type { Env } from '../env.js';

/**
 * Route-level integration harness.
 *
 * Wraps the tenant seeding in `@gs/db` with the Worker `Env` the routes need, so a route
 * test says what it is testing rather than how to boot the app.
 */

export { databaseUrl };
export type { TenantHarness };

export interface RouteHarness extends TenantHarness {
  env: Env;
}

export async function createHarness(
  ...args: Parameters<typeof createTenantHarness>
): Promise<RouteHarness> {
  const harness = await createTenantHarness(...args);

  return {
    ...harness,
    env: {
      ENVIRONMENT: 'test',
      SERVICE_VERSION: '0.1.0-integration',
      LOG_LEVEL: 'silent',
      API_KEY_HASH_PEPPER: harness.pepper,
      DATABASE_URL: harness.connectionString,
    },
  };
}

/** The middleware uses `waitUntil`, so an execution context has to exist. */
export const executionContext = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}),
  passThroughOnException() {},
} as unknown as ExecutionContext;
