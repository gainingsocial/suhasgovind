import type { ProviderCallContext } from './types.js';

/**
 * HTTP helper every adapter uses (Rule 6: every provider side effect needs a timeout, an
 * attempt record, normalized errors and observability).
 *
 * Putting this in the kit rather than in each adapter is not just deduplication. A
 * provider call that forgets its timeout will hang a Worker until the runtime kills it,
 * with nothing in the logs explaining why — and that mistake is invisible in review. Here
 * it is impossible: `signal` is required, and the response is logged whatever happens.
 */

/** Default per-call budget. Individual calls may shorten it, never lengthen it past the context deadline. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export interface ProviderRequestInit extends Omit<RequestInit, 'signal'> {
  /** Operation name for the attempt record, e.g. `publish`, `listDestinations`. */
  operation: string;
  /** Overrides the default budget. Clamped by the context's own deadline regardless. */
  timeoutMs?: number;
}

export interface ProviderResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed body when the response was JSON; `undefined` otherwise. */
  readonly json: unknown;
  readonly durationMs: number;
}

/**
 * Raised when a provider call exceeds its budget or the request is aborted.
 *
 * Deliberately its own type: a timeout is the one failure where we cannot tell whether
 * the side effect happened, so `normalizeError` must map it to `PROVIDER_TIMEOUT` and the
 * engine must reconcile before retrying (ADR-006 Layer 4). Letting it arrive as a generic
 * `TypeError` from fetch is how that distinction gets lost.
 */
export class ProviderTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Provider call "${operation}" exceeded ${timeoutMs}ms.`);
    this.name = 'ProviderTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** Raised when the transport itself failed — DNS, TLS, connection reset. */
export class ProviderTransportError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Provider call "${operation}" failed before a response was received.`);
    this.name = 'ProviderTransportError';
    this.operation = operation;
    this.cause = cause;
  }
}

/** Strips the query string; a token in a query parameter must never reach a log (P9). */
function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Header names carrying a provider request id, in the order they are commonly used.
 * Worth capturing: it is the first thing a provider's support team asks for.
 */
const REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-fb-trace-id',
  'x-li-uuid',
  'x-tt-logid',
  'request-id',
] as const;

function extractProviderRequestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Perform a provider HTTP call with a hard deadline, logging the outcome either way.
 *
 * Does not throw on a non-2xx: an adapter needs the body to normalize the error properly,
 * and a thrown response loses it. Only timeout and transport failure throw.
 */
export async function providerFetch(
  context: ProviderCallContext,
  url: string,
  init: ProviderRequestInit,
): Promise<ProviderResponse> {
  const { operation, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, ...requestInit } = init;
  const started = Date.now();

  // Two deadlines: this call's own budget, and the caller's overall deadline. Whichever
  // fires first wins, so a slow first call cannot consume the whole request's budget.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onOuterAbort = () => timeoutController.abort();
  context.signal.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetch(url, { ...requestInit, signal: timeoutController.signal });
    const text = await response.text();
    const durationMs = Date.now() - started;

    let json: unknown;
    if (text && (response.headers.get('content-type') ?? '').includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        // A provider that claims JSON and sends something else is itself a useful signal,
        // but it is the adapter's job to decide what to do about it.
      }
    }

    context.log({
      operation,
      method: requestInit.method ?? 'GET',
      path: safePath(url),
      status: response.status,
      durationMs,
      providerRequestId: extractProviderRequestId(response.headers),
    });

    return { status: response.status, ok: response.ok, headers: response.headers, text, json, durationMs };
  } catch (cause) {
    const durationMs = Date.now() - started;
    const aborted = timeoutController.signal.aborted;

    context.log({
      operation,
      method: requestInit.method ?? 'GET',
      path: safePath(url),
      durationMs,
      detail: { failure: aborted ? 'timeout' : 'transport' },
    });

    throw aborted
      ? new ProviderTimeoutError(operation, timeoutMs)
      : new ProviderTransportError(operation, cause);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Parse `Retry-After` into a UTC ISO-8601 instant (Rule 15).
 *
 * RFC 9110 §10.2.3 allows both delay-seconds and an HTTP-date, and providers use both.
 * Honouring it is required by the `respect_provider_retry_after` retry strategy — hammering
 * a provider that told us when to come back is how an app-level rate limit becomes a ban.
 */
export function parseRetryAfter(headers: Headers, now: Date = new Date()): string | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + seconds * 1000).toISOString();
  }

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    // A past date means "retry now"; clamping avoids scheduling in the past.
    return new Date(Math.max(date, now.getTime())).toISOString();
  }

  return undefined;
}
