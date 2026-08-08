import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from './env.js';
import { requestContext } from './middleware/request-context.js';
import { buildOpenApiDocument } from './openapi.js';
import { health } from './routes/health.js';

/**
 * Public API gateway (plan §6.1).
 *
 * Rule 10 — nothing long-running happens here. Routes validate, authorize and enqueue;
 * the queue consumers and workflows do the provider work.
 */
const app = new Hono<AppEnv>();

app.use('*', requestContext());

app.route('/health', health);
// Versioned alias: /health is for infrastructure probes, /v1/health for API clients that
// pin a version prefix on everything.
app.route('/v1/health', health);

app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(new URL(c.req.url).origin)));

/**
 * Unknown routes get the same envelope as everything else. A 404 that returns Hono's
 * plain-text default would force clients to special-case it.
 */
app.notFound((c) => {
  const trace = c.get('trace');
  const error = new ApiError('RESOURCE_NOT_FOUND', {
    message: `No route matches ${c.req.method} ${c.req.path}.`,
  });
  return c.json(error.toEnvelope(trace), error.status as 404);
});

app.onError((err, c) => {
  const trace = c.get('trace');
  const logger = c.get('logger');

  const error =
    err instanceof ApiError
      ? err
      : // An unexpected throw must never leak its message or stack to the caller — that is
        // where credentials and internal hostnames surface (P9).
        new ApiError('INTERNAL_ERROR', { cause: err });

  const level = error.status >= 500 ? 'error' : 'warn';
  logger[level]('request.failed', {
    code: error.code,
    status: error.status,
    method: c.req.method,
    path: c.req.path,
    // `redact()` in the logger scrubs the message before it is written.
    reason: err instanceof Error ? err.message : String(err),
  });

  return c.json(error.toEnvelope(trace), error.status as 500);
});

export default app;
