import { HealthResponseSchema } from '@gs/contracts/http';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Operational probes.
 *
 * Unauthenticated by design — a probe an on-call engineer cannot curl is not a probe.
 * They therefore return no tenant data and touch no tenant table, which is what keeps
 * them outside the ownership rules that govern every other route (plan P5).
 *
 * `/health` is liveness: the isolate booted and can answer. It deliberately does not
 * check Postgres — a database blip would otherwise make Cloudflare recycle a Worker that
 * is perfectly capable of serving cached and queue-bound work.
 */
export const health = new Hono<AppEnv>();

health.get('/', (c) => {
  const trace = c.get('trace');

  const body = HealthResponseSchema.parse({
    status: 'ok',
    environment: c.env.ENVIRONMENT,
    version: c.env.SERVICE_VERSION,
    // Rule 15 — UTC ISO-8601.
    timestamp: new Date().toISOString(),
    requestId: trace.requestId,
  });

  return c.json(body, 200);
});
