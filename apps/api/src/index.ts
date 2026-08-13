import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from './env.js';
import { requestContext } from './middleware/request-context.js';
import { buildOpenApiDocument } from './openapi.js';
import { health } from './routes/health.js';
import { me } from './routes/me.js';
import { apiKeys, environments } from './routes/api-keys.js';
import { connectRoutes, oauthCallbackRoutes } from './routes/connect.js';
import { connectSessions, hostedConnect } from './routes/connect-sessions.js';
import { createArticleRoutes } from './routes/articles.js';
import { connections } from './routes/connections.js';
import { brandProfiles, contentItems, contentSources } from './routes/content.js';
import { createDraftSetRoutes } from './routes/draft-sets.js';
import { media } from './routes/media.js';
import { memory, recommendations } from './routes/memory.js';
import { destinations, platforms, providerHealth } from './routes/platforms.js';
import { analytics } from './routes/analytics.js';
import { comments as inboxComments, conversations as inboxConversations } from './routes/inbox.js';
import { approvals } from './routes/approvals.js';
import { compose } from './routes/compose.js';
import { createMcpRoute } from './routes/mcp.js';
import { posts } from './routes/posts.js';
import { profiles } from './routes/profiles.js';
import { providerApps } from './routes/provider-apps.js';
import { usage } from './routes/usage.js';
import { webhookDeliveriesRoute, webhooks } from './routes/webhooks.js';

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
app.route('/v1/me', me);
/**
 * Mounted before the profile CRUD routes so `/:profileId/brand-profile` is matched as the
 * literal path it is rather than being swallowed by `/:profileId`.
 */
app.route('/v1/profiles', brandProfiles);
app.route('/v1/profiles', profiles);
// Mounted before the read routes so `/authorize` and `/complete` are matched as literal
// paths rather than being swallowed by `/:connectionId`.
app.route('/v1/connections', connectRoutes);
app.route('/v1/connections', connections);
/** Where every provider redirects back to. Unauthenticated by necessity (plan §21.2). */
app.route('/v1/oauth', oauthCallbackRoutes);
app.route('/v1/connect-sessions', connectSessions);
/**
 * The hosted white-label connect page (plan §22). Unversioned, because the URL is handed
 * to a customer's end user and may sit in an email for a day — pinning it to `/v1` would
 * make an API version bump break links that are already out in the world.
 */
app.route('/connect', hostedConnect);
app.route('/v1/platforms', platforms);
app.route('/v1/destinations', destinations);
app.route('/v1/provider-health', providerHealth);
app.route('/v1/media', media);
app.route('/v1/posts', posts);
app.route('/v1/compose', compose);
app.route('/v1/api-keys', apiKeys);
app.route('/v1/provider-apps', providerApps);
app.route('/v1/environments', environments);
app.route('/v1/analytics', analytics);
app.route('/v1/comments', inboxComments);
app.route('/v1/conversations', inboxConversations);
app.route('/v1/approvals', approvals);
app.route('/v1/usage', usage);
app.route('/v1/webhooks', webhooks);
app.route('/v1/webhook-deliveries', webhookDeliveriesRoute);

/**
 * Content Intelligence (plan §63Q).
 *
 * `/v1/draft-sets` is wired with the same internal dispatcher the MCP layer uses, because
 * publishing a draft set is publishing: it builds a `POST /v1/posts` body and re-enters the
 * API through its own front door rather than reimplementing idempotency, preflight and the
 * queue handoff. A second path into publishing is a second path that can be wrong about
 * duplicates.
 */
app.route('/v1/content-sources', contentSources);
app.route('/v1/content', contentItems);
app.route(
  '/v1/draft-sets',
  createDraftSetRoutes((request, env, ctx) => app.fetch(request, env, ctx as ExecutionContext)),
);

/**
 * Article sharing (plan §63O).
 *
 * The on-ramp for site owners, and the shared engine behind the WordPress plugin, the
 * site-builder apps, the browser extension and the agent tool. Wired with the internal
 * dispatcher so it composes the existing media and compose routes rather than acquiring a
 * second copy of their platform rules.
 */
app.route(
  '/v1/articles',
  createArticleRoutes((request, env, ctx) => app.fetch(request, env, ctx as ExecutionContext)),
);

/**
 * Social memory and the optimization loop (plan Phase 10).
 *
 * `/v1/memory/learn` is explicit rather than automatic: recomputing is a full scan of a
 * profile's analytics, which does not belong in a request path somebody is waiting on and
 * should not be a cost that arrives by surprise.
 */
app.route('/v1/memory', memory);
app.route('/v1/recommendations', recommendations);

/**
 * The MCP endpoint (plan §50).
 *
 * Mounted last, and wired with `app.request` so every tool call re-enters this same
 * application through its own front door: the same middleware, the same authentication,
 * the same handler. Plan §50 forbids duplicate social logic inside MCP, and dispatching
 * through the app is a structural guarantee rather than a convention somebody has to keep.
 *
 * Unversioned, because the URL goes into an agent's configuration and stays there. The
 * protocol version it speaks is negotiated per request, which is a finer-grained and more
 * honest control than a path prefix.
 */
app.route(
  '/mcp',
  // The bindings and execution context of the *outer* request are handed through, so an
  // internal call reaches the same database binding and the same `waitUntil` budget. A
  // dispatch built without them would authenticate against nothing.
  createMcpRoute((request, env, ctx) =>
    app.fetch(request, env, ctx as ExecutionContext),
  ),
);

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
