import type { NormalizedProviderError } from '@gs/errors';
import {
  parseRetryAfter,
  providerFetch,
  ProviderTimeoutError,
  ProviderTransportError,
  type ProviderCallContext,
  type ProviderCredentials,
} from '@gs/provider-kit';

/**
 * Shared Graph API transport for the Meta family (Facebook Pages, Instagram, Threads).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *   https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 *   https://developers.facebook.com/docs/graph-api/securing-requests
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens
 *
 * This package is a library, not an adapter: it is never registered in `@gs/providers`
 * and has no `ProviderName`. It exists because Facebook, Instagram and Threads share one
 * error envelope, one rate-limit protocol and one token-security scheme, and because a
 * mistake in mapping error code 506 would be a duplicate-post bug repeated three times.
 *
 * Adapters keep their own endpoints, capabilities and validation. Only the parts that are
 * genuinely identical across all three live here (plan §75).
 */

/**
 * Pinned Graph API version.
 *
 * Meta guarantees roughly two years of support per version and then sunsets it — calls to
 * a retired version start failing with no code change on our side. Pinned as a reviewed
 * constant rather than left unversioned: an unversioned Graph call is served by the
 * oldest *available* version, which is the one closest to being switched off.
 */
export const GRAPH_VERSION = 'v23.0';

export const GRAPH_HOST = 'https://graph.facebook.com';

/** Threads is a Graph API but on its own host, with its own app registration. */
export const THREADS_HOST = 'https://graph.threads.net';

/**
 * A Graph API failure, carrying Meta's own numeric code.
 *
 * The numeric `code` and `subcode` are the stable contract; `message` is prose Meta
 * rewords freely. Every mapping decision below branches on the numbers.
 */
export class GraphError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  /** Meta's internal support identifier. The first thing their support team asks for. */
  readonly fbtraceId: string | undefined;
  /** Meta's own end-user-safe wording, when it supplies one. */
  readonly userMessage: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(
    status: number,
    body: GraphErrorBody | undefined,
    fallbackMessage: string,
    retryAfter?: string,
  ) {
    super(body?.message ?? fallbackMessage);
    this.name = 'GraphError';
    this.status = status;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.type = body?.type;
    this.fbtraceId = body?.fbtrace_id;
    this.userMessage = body?.error_user_msg;
    this.retryAfter = retryAfter;
  }
}

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
}

/**
 * Compute `appsecret_proof` — an HMAC-SHA256 of the access token, keyed by the app secret.
 *
 * Meta uses it to prove a call came from our server rather than from someone who stole a
 * token: the secret never leaves us, so a leaked token alone cannot produce a valid proof.
 * Apps can be configured to *require* it, and when that setting is on, calls without it
 * fail with a code 1 that reads like a transient server fault — which is exactly the kind
 * of misdiagnosis that costs an afternoon. Sending it always is free.
 *
 * https://developers.facebook.com/docs/graph-api/securing-requests
 */
export async function appSecretProof(accessToken: string, appSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(accessToken));

  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface GraphCallInput {
  readonly host?: string;
  readonly accessToken: string;
  /** Omit for hosts that do not support the proof (Threads does not use one). */
  readonly appSecret?: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path below the version segment, e.g. `/me/accounts`. */
  readonly path: string;
  /** Query parameters. Never put the access token here — see below. */
  readonly query?: Record<string, string | undefined>;
  /** Form body. The Graph API takes `application/x-www-form-urlencoded`, not JSON. */
  readonly form?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  /** Overrides the operation label in the attempt record. */
  readonly operation?: string;
}

/**
 * Rate-limit telemetry Meta returns on every response.
 *
 * Worth capturing even when the call succeeded: these headers are how you find out you are
 * at 90% of an hourly budget *before* the platform starts refusing posts, and
 * `estimated_time_to_regain_access` is the only reliable answer to "when can we retry"
 * once it does — Meta does not send `Retry-After` for its own throttles.
 *
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */
export interface GraphUsage {
  /** Highest percentage across call count, CPU time and total time. 0–100+. */
  readonly worstPercent: number;
  /** Minutes until throttling lifts, when Meta says. */
  readonly regainAccessInMinutes?: number;
}

function readUsage(headers: Headers): GraphUsage | undefined {
  let worstPercent = 0;
  let regainAccessInMinutes: number | undefined;
  let saw = false;

  const appUsage = headers.get('x-app-usage');
  if (appUsage) {
    try {
      const parsed = JSON.parse(appUsage) as Record<string, number>;
      for (const value of Object.values(parsed)) {
        if (typeof value === 'number') worstPercent = Math.max(worstPercent, value);
      }
      saw = true;
    } catch {
      // A malformed usage header is not worth failing a successful publish over.
    }
  }

  // Business use case usage is keyed by business id and holds an array per key, so it
  // needs a different walk from the flat app usage object.
  const businessUsage = headers.get('x-business-use-case-usage');
  if (businessUsage) {
    try {
      const parsed = JSON.parse(businessUsage) as Record<string, Record<string, number>[]>;
      for (const entries of Object.values(parsed)) {
        for (const entry of entries) {
          for (const [key, value] of Object.entries(entry)) {
            if (typeof value !== 'number') continue;
            if (key === 'estimated_time_to_regain_access') {
              regainAccessInMinutes = Math.max(regainAccessInMinutes ?? 0, value);
            } else if (key.endsWith('_util') || key.endsWith('_usage')) {
              worstPercent = Math.max(worstPercent, value);
            }
          }
        }
      }
      saw = true;
    } catch {
      // Same reasoning as above.
    }
  }

  if (!saw) return undefined;
  return regainAccessInMinutes === undefined
    ? { worstPercent }
    : { worstPercent, regainAccessInMinutes };
}

export interface GraphResult<T> {
  readonly data: T;
  readonly headers: Headers;
  readonly usage: GraphUsage | undefined;
}

/**
 * Perform one Graph API call.
 *
 * The access token goes in the `Authorization` header, never in the query string. Meta
 * accepts both, and the query-string form is what most examples show — but a URL is the
 * one part of a request that gets logged by default at every hop, and P9 says a credential
 * must never reach a log. `providerFetch` strips query strings from its own attempt record
 * for the same reason; putting the token somewhere it strips would still leak it to
 * Cloudflare's request log on the way out.
 */
export async function graphCall<T>(
  context: ProviderCallContext,
  input: GraphCallInput,
): Promise<GraphResult<T>> {
  const host = input.host ?? GRAPH_HOST;
  const url = new URL(`${host}/${GRAPH_VERSION}${input.path}`);

  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const proof = input.appSecret ? await appSecretProof(input.accessToken, input.appSecret) : undefined;
  if (proof) url.searchParams.set('appsecret_proof', proof);

  const body = input.form
    ? new URLSearchParams(
        Object.entries(input.form).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ).toString()
    : undefined;

  const response = await providerFetch(context, url.toString(), {
    operation: input.operation ?? input.path,
    method: input.method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  const usage = readUsage(response.headers);

  if (usage && usage.worstPercent >= 80) {
    // Logged rather than thrown: still under the limit, but this is the window in which a
    // human can act before Meta starts refusing posts.
    context.log({
      operation: input.operation ?? input.path,
      method: input.method,
      path: url.pathname,
      status: response.status,
      durationMs: response.durationMs,
      detail: { rateLimitUsagePercent: usage.worstPercent },
    });
  }

  if (!response.ok) {
    const envelope = (response.json ?? {}) as { error?: GraphErrorBody };
    throw new GraphError(
      response.status,
      envelope.error,
      `Meta returned ${response.status}.`,
      parseRetryAfter(response.headers) ??
        (usage?.regainAccessInMinutes !== undefined
          ? new Date(Date.now() + usage.regainAccessInMinutes * 60_000).toISOString()
          : undefined),
    );
  }

  return { data: (response.json ?? {}) as T, headers: response.headers, usage };
}

/**
 * Meta error codes this file maps deliberately.
 *
 * Named rather than inlined, because the difference between 506 and 100 is the difference
 * between "reconcile, a post may exist" and "the caller sent something wrong".
 */
export const GRAPH_CODE = {
  /** Transient, unclassified. Also what a missing appsecret_proof looks like. */
  API_UNKNOWN: 1,
  /** Temporary Meta-side downtime. */
  API_SERVICE: 2,
  /** App-level call volume exceeded. */
  APP_TOO_MANY_CALLS: 4,
  PERMISSION_DENIED: 10,
  USER_TOO_MANY_CALLS: 17,
  /** Invalid parameter. Subcode 33 means the object is gone or invisible to this token. */
  INVALID_PARAMETER: 100,
  ACCESS_TOKEN_PROBLEM: 190,
  APPLICATION_LIMIT_REACHED: 341,
  /** Temporarily blocked for policy violations. */
  POLICY_BLOCK: 368,
  /** Meta refused because the identical post already exists. */
  DUPLICATE_POST: 506,
} as const;

/** Subcodes of 190 that all mean the same thing to us: reconnect. */
const REAUTH_SUBCODES = new Set([458, 460, 463, 467, 490, 492]);

/**
 * Map a Graph failure onto the shared taxonomy (plan §79).
 *
 * The one that matters most is **506, Duplicate Post**. Meta refuses to publish content
 * identical to something the account posted recently. Seen on a first attempt it is a
 * content problem. Seen on a *retry* after an ambiguous timeout it is near-proof that the
 * first attempt actually succeeded and we never saw the response.
 *
 * The adapter cannot tell those apart on its own, and guessing either way is a real
 * failure: call it `CONTENT_REJECTED` and a genuinely published post is marked failed;
 * retry it and the account gets two posts. `POSSIBLE_DUPLICATE` routes it to
 * reconciliation, which asks Meta what actually exists before anything else happens
 * (ADR-006 Layer 4).
 *
 * @param platform Name used in the human-readable message, e.g. `Facebook`.
 */
export function normalizeGraphError(
  error: unknown,
  platform: string,
  operation: string,
): NormalizedProviderError | null {
  if (error instanceof ProviderTimeoutError) {
    return { code: 'PROVIDER_TIMEOUT', message: `${platform} timed out during ${operation}.` };
  }
  if (error instanceof ProviderTransportError) {
    return { code: 'PROVIDER_UNAVAILABLE', message: `${platform} was unreachable during ${operation}.` };
  }
  if (!(error instanceof GraphError)) return null;

  // Meta's own wording is often better than ours ("Your account is temporarily blocked
  // from posting"), so prefer it when present.
  const message = error.userMessage ?? error.message;

  switch (error.code) {
    case GRAPH_CODE.DUPLICATE_POST:
      return {
        code: 'POSSIBLE_DUPLICATE',
        message: `${platform} refused this as a duplicate of an existing post. ${message}`,
        status: error.status,
      };

    case GRAPH_CODE.ACCESS_TOKEN_PROBLEM:
      // 190 without a subcode is a plain expiry; the listed subcodes mean the user did
      // something (changed a password, uninstalled the app) that a refresh cannot undo.
      return {
        code: error.subcode !== undefined && REAUTH_SUBCODES.has(error.subcode) ? 'AUTH_REVOKED' : 'AUTH_EXPIRED',
        message,
        status: error.status,
      };

    case GRAPH_CODE.PERMISSION_DENIED:
      return { code: 'AUTH_SCOPE_MISSING', message, status: error.status };

    case GRAPH_CODE.APP_TOO_MANY_CALLS:
    case GRAPH_CODE.USER_TOO_MANY_CALLS:
    case GRAPH_CODE.APPLICATION_LIMIT_REACHED:
      return {
        code: 'RATE_LIMITED',
        message,
        status: error.status,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      };

    case GRAPH_CODE.POLICY_BLOCK:
      // Meta classes this as transient, but it is a policy action against the account, not
      // a busy server. Backing off is right; treating it as a content problem is not,
      // because the same content will publish fine once the block lifts.
      return {
        code: 'RATE_LIMITED',
        message: `${platform} has temporarily blocked this account from posting. ${message}`,
        status: error.status,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      };

    case GRAPH_CODE.API_UNKNOWN:
    case GRAPH_CODE.API_SERVICE:
      return { code: 'PROVIDER_UNAVAILABLE', message, status: error.status };

    case GRAPH_CODE.INVALID_PARAMETER:
      // Subcode 33 is "object does not exist, or this token cannot see it". Almost always
      // a Page that was disconnected or a permission that was withdrawn, so pointing at
      // the destination is more useful than "invalid parameter".
      return error.subcode === 33
        ? { code: 'DESTINATION_NOT_FOUND', message, status: error.status }
        : { code: 'VALIDATION_FAILED', message, status: error.status };
  }

  // The 200–299 block is documented as a family, not as individual codes.
  if (error.code !== undefined && error.code >= 200 && error.code <= 299) {
    return { code: 'AUTH_SCOPE_MISSING', message, status: error.status };
  }

  if (error.type === 'OAuthException') {
    return { code: 'AUTH_EXPIRED', message, status: error.status };
  }

  if (error.status === 429) {
    return {
      code: 'RATE_LIMITED',
      message,
      status: 429,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    };
  }
  if (error.status >= 500) {
    return { code: 'PROVIDER_UNAVAILABLE', message, status: error.status };
  }
  if (error.status === 404) {
    return { code: 'DESTINATION_NOT_FOUND', message, status: 404 };
  }
  if (error.status === 400) {
    return { code: 'VALIDATION_FAILED', message, status: 400 };
  }

  // Rule 14 — no guess. An unrecognized code is not auto-retried, because a retry could
  // duplicate a post we cannot prove did not publish.
  return null;
}

/** Pull the access token off a credential, failing with something actionable if absent. */
export function requireAccessToken(credentials: ProviderCredentials, platform: string): string {
  if (!credentials.accessToken) {
    throw new GraphError(401, { code: 190, message: `This ${platform} connection has no access token.` }, '');
  }
  return credentials.accessToken;
}
