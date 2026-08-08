/**
 * Health and readiness contracts (plan §85 Rule 5 — every public route carries a schema).
 *
 * These are the only unauthenticated routes in the API. They deliberately expose no
 * tenant data: an operational probe must be answerable by anyone holding the URL, so
 * anything it returns is effectively public.
 */
import { z } from 'zod';

/**
 * `live` and `test` mirror the environment kinds in the database; `development` covers
 * `wrangler dev` and CI, which are attached to no environment record at all.
 */
export const DeploymentEnvironmentSchema = z.enum(['development', 'test', 'live']);

export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

/** No path, query or body parameters — declared so the OpenAPI registration is uniform. */
export const HealthRequestSchema = z.object({});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  environment: DeploymentEnvironmentSchema,
  /** Build identifier, so a probe can tell which deploy answered it. */
  version: z.string(),
  /** Rule 15 — every public timestamp is UTC ISO-8601. */
  timestamp: z.iso.datetime(),
  /** Echoed so a caller can quote one identifier when reporting a problem (plan §40). */
  requestId: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
