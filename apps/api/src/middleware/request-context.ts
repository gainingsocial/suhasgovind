import { newRequestId, newTraceId } from '@gs/contracts/ids';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/** Response header every route echoes, so a caller can quote one id (plan §40). */
export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACE_ID_HEADER = 'x-trace-id';

/** W3C traceparent: version-traceid-spanid-flags. We only read the trace id. */
const TRACEPARENT = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * An inbound id is echoed only if it is well-formed. Accepting arbitrary caller text
 * would let a client write unbounded, unescaped data straight into our log lines.
 */
function sanitizeId(value: string | undefined, maxLength = 128): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

function inboundTraceId(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT.exec(header.trim());
  return match?.[1];
}

/**
 * Establishes the trace context and request-scoped logger, and propagates the ids back on
 * the response (plan §85 Rule 5 — request ID propagation).
 */
export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const trace = newTraceContext({
      requestId: sanitizeId(c.req.header(REQUEST_ID_HEADER)) ?? newRequestId(),
      traceId:
        inboundTraceId(c.req.header('traceparent')) ??
        sanitizeId(c.req.header(TRACE_ID_HEADER)) ??
        newTraceId(),
      environment: c.env.ENVIRONMENT === 'live' ? 'live' : 'test',
    });

    const logger = createLogger(trace, {
      level: parseLogLevel(c.env.LOG_LEVEL),
      service: 'api',
    });

    c.set('trace', trace);
    c.set('logger', logger);

    // Set before `next()` so the ids survive an error path that replaces the response.
    c.header(REQUEST_ID_HEADER, trace.requestId);
    c.header(TRACE_ID_HEADER, trace.traceId);

    const startedAt = Date.now();
    await next();

    logger.info('request.completed', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
  };
}
