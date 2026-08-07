import { newRequestId, newTraceId } from '@gs/contracts/ids';

import { redact } from './redaction.js';

/**
 * Structured logging with mandatory correlation context (plan §40, P10).
 *
 * Every log line carries the trace ID, so one identifier reconstructs a request's whole
 * story: API request → workflow → queue message → provider call → webhook delivery.
 *
 * Output is one JSON object per line, which is what Cloudflare's Logpush and every log
 * aggregator expect. Nothing here formats for human reading — that is the dashboard's job.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Correlation context threaded through every layer.
 *
 * `traceId` survives across process boundaries (it goes into queue messages and workflow
 * params); `requestId` identifies one HTTP request and does not.
 */
export interface TraceContext {
  traceId: string;
  requestId: string;
  organizationId?: string;
  projectId?: string;
  environmentId?: string;
  environment?: 'test' | 'live';
  profileId?: string;
  apiKeyId?: string;
  provider?: string;
  connectionId?: string;
  destinationId?: string;
  postId?: string;
  targetId?: string;
  /** Set on queue consumers and workflow steps so async work is attributable. */
  jobId?: string;
  workflowId?: string;
}

export function newTraceContext(partial: Partial<TraceContext> = {}): TraceContext {
  return {
    traceId: partial.traceId ?? newTraceId(),
    requestId: partial.requestId ?? newRequestId(),
    ...partial,
  };
}

export interface LogFields {
  [key: string]: unknown;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Overridable sink. Tests capture lines; production writes to stdout. */
  sink?: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  service?: string;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger with additional bound context — e.g. per publish target. */
  child(context: Partial<TraceContext>, fields?: LogFields): Logger;
  readonly context: TraceContext;
}

/* eslint-disable no-restricted-properties -- this module is the logging sink itself. */
const defaultSink = (line: string): void => {
  console.log(line);
};
/* eslint-enable no-restricted-properties */

export function createLogger(context: TraceContext, options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const service = options.service;

  const build = (boundContext: TraceContext, boundFields: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < minimum) return;

      // Redaction applies to the caller's fields, not to our own context, which contains
      // only opaque IDs by construction.
      const merged = { ...boundFields, ...fields };
      const payload = {
        // Plan §85 Rule 15 — all timestamps are UTC ISO-8601.
        timestamp: now().toISOString(),
        level,
        message,
        ...(service ? { service } : {}),
        ...boundContext,
        ...(Object.keys(merged).length > 0 ? (redact(merged) as LogFields) : {}),
      };

      try {
        sink(JSON.stringify(payload));
      } catch {
        // A field that cannot be serialized must never take down a publish. Fall back to
        // the correlation context alone so the event is still traceable.
        sink(
          JSON.stringify({
            timestamp: now().toISOString(),
            level,
            message,
            ...boundContext,
            log_error: 'payload_not_serializable',
          }),
        );
      }
    };

    return {
      context: boundContext,
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warn: (message, fields) => emit('warn', message, fields),
      error: (message, fields) => emit('error', message, fields),
      child: (childContext, childFields) =>
        build({ ...boundContext, ...childContext }, { ...boundFields, ...childFields }),
    };
  };

  return build(context, {});
}

/** Parse a log level from configuration, falling back to `info` on anything unexpected. */
export function parseLogLevel(value: string | undefined): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : 'info';
}
