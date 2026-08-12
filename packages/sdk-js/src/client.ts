import type { ErrorEnvelopeShape } from '@gs/contracts/http';

import { GainingSocialError } from './errors.js';

/**
 * The transport every resource goes through.
 *
 * Deliberately dependency-free and built on global `fetch`, so the same file runs in
 * Node 18+, Cloudflare Workers, Deno, Bun and a browser. A generated client that assumes
 * Node streams is the reason so many API SDKs cannot be used from an edge runtime, and
 * this product's own API runs on one.
 */

export const DEFAULT_BASE_URL = 'https://api.gainingsocial.com';

/** Per-request budget. Generous enough for a preflight that calls several providers. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Retries of a *retryable* failure, on top of the first attempt.
 *
 * Three is the point where a transient provider blip is absorbed but a genuine outage is
 * reported rather than silently absorbing thirty seconds of the caller's time.
 */
export const DEFAULT_MAX_RETRIES = 2;

export interface ClientOptions {
  /** `sk_live_...` or `sk_test_...`. The environment is encoded in the key (plan §6). */
  apiKey: string;
  /** Override for self-hosted or staging deployments. */
  baseUrl?: string;
  /** Inject a fetch implementation — for tests, or a runtime without a global. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Appended to the SDK's own User-Agent so integrations are attributable in logs. */
  appName?: string;
}

export interface RequestOptions {
  /**
   * Overrides the automatic key on endpoints that require one.
   *
   * Supply this when the caller has its own notion of "the same request" — a job id, say.
   * Leaving it out is safe for a single call, but a generated key changes on every retry
   * *by the caller*, which is exactly when an explicit key matters (plan §25).
   */
  idempotencyKey?: string;
  /** Abort the request from outside — a user navigating away, a job being cancelled. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface InternalRequest extends RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Endpoints where the API rejects a request without an Idempotency-Key. */
  requiresIdempotencyKey?: boolean;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * How long to wait before attempt `n`.
 *
 * `Retry-After` wins when the API sends one: it is the server saying when it will be
 * ready, and guessing shorter is how a rate limit becomes a ban. Otherwise exponential
 * with full jitter — synchronised clients retrying in lockstep is what turns a brief blip
 * into a thundering herd.
 */
function backoffMs(attempt: number, retryAfter: string | undefined): number {
  if (retryAfter) {
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const ceiling = Math.min(1000 * 2 ** attempt, 8000);
  return Math.random() * ceiling;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(GainingSocialError.transport('The request was aborted while waiting to retry.'));
      },
      { once: true },
    );
  });
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      // Failing here, rather than on the first call, means the mistake surfaces at the
      // line that made it.
      throw new Error('An API key is required. Create one in the dashboard under API keys.');
    }

    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.userAgent = options.appName
      ? `gainingsocial-sdk-js/0.1.0 (${options.appName})`
      : 'gainingsocial-sdk-js/0.1.0';

    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'No fetch implementation is available. Use Node 18 or later, or pass one as `fetch`.',
      );
    }
  }

  async request<T>(input: InternalRequest): Promise<T> {
    // Generated once, outside the retry loop. Regenerating per attempt would defeat the
    // entire purpose: two attempts with two keys are two posts (plan §25 Layer 1).
    const idempotencyKey =
      input.idempotencyKey ?? (input.requiresIdempotencyKey ? crypto.randomUUID() : undefined);

    let lastError: GainingSocialError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1, lastError?.retryAfter), input.signal);
      }

      try {
        return await this.attempt<T>(input, idempotencyKey);
      } catch (error) {
        if (!(error instanceof GainingSocialError)) throw error;
        // The API tells us whether another attempt could succeed. Guessing from the status
        // code would retry a duplicate-content 409 that can only ever fail the same way.
        if (!error.retryable) throw error;
        lastError = error;
      }
    }

    throw lastError ?? GainingSocialError.transport('The request failed for an unknown reason.');
  }

  private async attempt<T>(input: InternalRequest, idempotencyKey: string | undefined): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? this.timeoutMs);
    const onOuterAbort = () => timeout.abort();
    input.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await this.fetchImpl(buildUrl(this.baseUrl, input.path, input.query), {
        method: input.method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          'user-agent': this.userAgent,
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: timeout.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw this.toError(response.status, text);
      }

      // 204 and an empty 200 are both legitimate — a disconnect returns no body.
      return (text ? (JSON.parse(text) as T) : (undefined as T));
    } catch (cause) {
      if (cause instanceof GainingSocialError) throw cause;

      // An abort from the caller's own signal is their decision, not a failure to retry.
      if (input.signal?.aborted) {
        throw GainingSocialError.transport('The request was aborted.', cause);
      }
      if (timeout.signal.aborted) {
        throw GainingSocialError.transport(
          `The request did not complete within ${input.timeoutMs ?? this.timeoutMs}ms.`,
          cause,
        );
      }
      throw GainingSocialError.transport('Could not reach the API.', cause);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private toError(status: number, text: string): GainingSocialError {
    try {
      const parsed = JSON.parse(text) as Partial<ErrorEnvelopeShape>;
      if (parsed.error?.code) {
        return new GainingSocialError(status, parsed.error);
      }
    } catch {
      // Falls through to `malformed`. A gateway timing out in front of the API returns
      // HTML, and pretending that is an envelope would produce a nonsense `code`.
    }
    return GainingSocialError.malformed(status, text);
  }
}
