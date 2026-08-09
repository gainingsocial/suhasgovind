import { createDatabaseFromEnv } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Opens one database handle per request and guarantees it is closed.
 *
 * Deliberately runs *before* `authenticate`, so authentication and the route share a
 * single connection. Opening a second one for the key lookup doubled the connection
 * setup on every authenticated request — invisible behind Hyperdrive's pooling in
 * production, but it doubled the cost against a direct connection, and two handles where
 * one will do is a thing to get right once rather than measure later.
 *
 * Closing is deferred through `waitUntil` rather than awaited: a `waitUntil` task started
 * by the route (an audit write, a usage counter) may still be using the connection, and
 * closing it synchronously would cut that write off mid-flight.
 */
export function withDatabase(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.env.HYPERDRIVE && !c.env.DATABASE_URL) {
      // Rule 14 — a missing binding is a deployment fault, and saying so precisely beats
      // failing deeper with a driver error nobody can act on.
      throw new ApiError('INTERNAL_ERROR', {
        message: 'No database binding is configured: bind HYPERDRIVE or set DATABASE_URL.',
      });
    }

    const handle = createDatabaseFromEnv(c.env);
    c.set('db', handle.db);

    try {
      await next();
    } finally {
      c.executionCtx.waitUntil(handle.close());
    }
  };
}
