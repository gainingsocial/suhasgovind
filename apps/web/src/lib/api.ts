/**
 * API client.
 *
 * The dashboard is an API client and nothing more (plan P11/P15). It holds no database
 * credentials and imports no repository — `pnpm boundaries` enforces that. Every screen
 * here consumes exactly the same public contracts an external customer would, which is
 * what stops the dashboard quietly depending on behaviour the API does not actually
 * offer.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8787';

export interface ApiErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    retryable: boolean;
    agent_action?: string;
    request_id: string;
  };
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error.message ?? fallback);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.error.code ?? 'UNKNOWN';
    this.requestId = body?.error.request_id;
  }
}

export interface ListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Perform an API call with the caller's key.
 *
 * The key is passed explicitly rather than read from a module-level variable: server
 * components render concurrently, and a shared mutable credential is how one tenant's
 * request ends up authenticated as another's.
 */
export async function apiFetch<T>(
  path: string,
  options: { apiKey: string; method?: string; body?: unknown; idempotencyKey?: string } ,
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Publishing state changes constantly; a cached list would show a post as queued
    // long after it published.
    cache: 'no-store',
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new ApiRequestError(response.status, parsed as ApiErrorBody | null, `Request failed with ${response.status}.`);
  }

  return parsed as T;
}
