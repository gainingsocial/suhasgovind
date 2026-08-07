import type { Logger } from './logger.js';
import { redact, redactUrl } from './redaction.js';

/**
 * Sanitized provider call recording (plan §40, §85 Rule 6).
 *
 * Every provider side effect produces one of these. It is what makes
 * `GET /v1/posts/{id}/timeline` genuinely useful — a customer can see that we called
 * LinkedIn, what status came back and how long it took, without us storing their token.
 *
 * The record is deliberately small and bounded. Provider responses can be megabytes;
 * storing them in full would dominate the database and is a compliance liability.
 */

export interface ProviderCallRecord {
  provider: string;
  operation: string;
  method: string;
  /** Query string redacted. */
  url: string;
  requestSummary?: unknown;
  status?: number;
  responseSummary?: unknown;
  durationMs: number;
  outcome: 'success' | 'client_error' | 'server_error' | 'timeout' | 'network_error';
  /** Our normalized taxonomy code when the call failed (plan §79). */
  normalizedErrorCode?: string;
  /** Rate-limit headers the provider returned, for the limiter to learn from (plan §29). */
  rateLimit?: {
    limit?: number;
    remaining?: number;
    resetAt?: string;
    retryAfterSeconds?: number;
  };
  attemptNumber?: number;
}

/** Cap on any persisted summary, so one payload cannot dominate storage. */
const MAX_SUMMARY_BYTES = 4096;

function boundedSummary(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;

  const redacted = redact(value, { maxStringLength: 512 });
  const serialized = JSON.stringify(redacted);

  if (serialized !== undefined && serialized.length > MAX_SUMMARY_BYTES) {
    return { truncated: true, bytes: serialized.length, excerpt: serialized.slice(0, 1024) };
  }
  return redacted;
}

/**
 * Build the persistable record. Note that neither the request nor the response body is
 * stored wholesale — callers pass a deliberately chosen summary (plan §7.2 "redact
 * provider request/response payload paths marked secret before persistence").
 */
export function buildProviderCallRecord(input: ProviderCallRecord): ProviderCallRecord {
  return {
    ...input,
    url: redactUrl(input.url),
    requestSummary: boundedSummary(input.requestSummary),
    responseSummary: boundedSummary(input.responseSummary),
  };
}

export function logProviderCall(logger: Logger, record: ProviderCallRecord): void {
  const sanitized = buildProviderCallRecord(record);
  const level = sanitized.outcome === 'success' ? 'debug' : 'warn';

  logger[level]('provider_call', {
    provider: sanitized.provider,
    operation: sanitized.operation,
    method: sanitized.method,
    url: sanitized.url,
    status: sanitized.status,
    duration_ms: sanitized.durationMs,
    outcome: sanitized.outcome,
    normalized_error_code: sanitized.normalizedErrorCode,
    attempt: sanitized.attemptNumber,
    rate_limit: sanitized.rateLimit,
  });
}

/**
 * Parse the rate-limit signals a provider returned.
 *
 * Providers disagree on header names, so adapters may override; these are the common
 * conventions (IETF draft `RateLimit-*`, GitHub/Twitter `X-RateLimit-*`, and the
 * universal `Retry-After`).
 */
export function parseRateLimitHeaders(
  headers: Headers,
  now: Date = new Date(),
): ProviderCallRecord['rateLimit'] {
  const read = (...names: string[]): string | null => {
    for (const name of names) {
      const value = headers.get(name);
      if (value !== null) return value;
    }
    return null;
  };

  const limit = read('RateLimit-Limit', 'X-RateLimit-Limit', 'x-rate-limit-limit');
  const remaining = read('RateLimit-Remaining', 'X-RateLimit-Remaining', 'x-rate-limit-remaining');
  const reset = read('RateLimit-Reset', 'X-RateLimit-Reset', 'x-rate-limit-reset');
  const retryAfter = read('Retry-After');

  const result: NonNullable<ProviderCallRecord['rateLimit']> = {};

  if (limit !== null && Number.isFinite(Number(limit))) result.limit = Number(limit);
  if (remaining !== null && Number.isFinite(Number(remaining))) result.remaining = Number(remaining);

  if (reset !== null) {
    const numeric = Number(reset);
    if (Number.isFinite(numeric)) {
      // Ambiguous by convention: small values are "seconds from now", large values are a
      // Unix epoch timestamp. The 10-year threshold separates them unambiguously.
      const resetAt =
        numeric > 10_000_000_000
          ? new Date(numeric)
          : numeric > 1_000_000_000
            ? new Date(numeric * 1000)
            : new Date(now.getTime() + numeric * 1000);
      result.resetAt = resetAt.toISOString();
    }
  }

  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      result.retryAfterSeconds = seconds;
      result.resetAt ??= new Date(now.getTime() + seconds * 1000).toISOString();
    } else {
      // Retry-After may also be an HTTP-date.
      const date = new Date(retryAfter);
      if (!Number.isNaN(date.getTime())) {
        result.resetAt = date.toISOString();
        result.retryAfterSeconds = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
