import {
  parseRetryAfter,
  providerFetch,
  ProviderTimeoutError,
  type ProviderCallContext,
} from '@gs/provider-kit';

import { DEFAULT_PDS, XRPC } from './constants.js';

/**
 * Thin XRPC client for the AT Protocol.
 *
 * Every call goes through `providerFetch`, so the timeout and the attempt log are not
 * optional (Rule 6). This deliberately does not use `@atproto/api`: that SDK carries its
 * own session management and retry behaviour, and a bundled SDK in a Worker costs
 * cold-start time on every request. The surface we need is six endpoints.
 */

/**
 * An XRPC error response.
 *
 * atproto returns a machine-readable `error` name alongside the message, which is what
 * `normalizeError` branches on. Branching on the human message would break the first time
 * Bluesky rewords it.
 */
export class AtProtoError extends Error {
  readonly status: number;
  /** e.g. `ExpiredToken`, `InvalidRequest`, `RateLimitExceeded`. */
  readonly errorName: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, errorName: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'AtProtoError';
    this.status = status;
    this.errorName = errorName;
    this.retryAfter = retryAfter;
  }
}

export interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

interface XrpcErrorBody {
  error?: string;
  message?: string;
}

function serviceUrl(pds: string | undefined, path: string): string {
  return `${(pds ?? DEFAULT_PDS).replace(/\/$/, '')}${path}`;
}

/** Raise an AtProtoError for a non-2xx, preserving the machine-readable error name. */
function raise(status: number, headers: Headers, body: unknown, fallback: string): never {
  const parsed = (body ?? {}) as XrpcErrorBody;
  throw new AtProtoError(
    status,
    parsed.error,
    parsed.message ?? parsed.error ?? fallback,
    parseRetryAfter(headers),
  );
}

export async function call<T>(
  context: ProviderCallContext,
  input: {
    pds?: string;
    path: string;
    method: 'GET' | 'POST';
    operation: string;
    accessJwt?: string;
    body?: unknown;
    query?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<T> {
  const url = new URL(serviceUrl(input.pds, input.path));
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {};
  if (input.accessJwt) headers.authorization = `Bearer ${input.accessJwt}`;
  if (input.body !== undefined) headers['content-type'] = 'application/json';

  const response = await providerFetch(context, url.toString(), {
    operation: input.operation,
    method: input.method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (!response.ok) {
    raise(response.status, response.headers, response.json, `Bluesky returned ${response.status}.`);
  }

  return response.json as T;
}

/**
 * Sign in with an app password (https://docs.bsky.app/blog/create-post).
 *
 * `identifier` accepts a handle or an email. Bluesky recommends app passwords over the
 * account password precisely so a third party cannot change account settings — which is
 * why the connect flow asks for one and this adapter never accepts anything else.
 */
export async function createSession(
  context: ProviderCallContext,
  input: { pds?: string; identifier: string; password: string },
): Promise<Session> {
  return call<Session>(context, {
    pds: input.pds,
    path: XRPC.createSession,
    method: 'POST',
    operation: 'createSession',
    body: { identifier: input.identifier, password: input.password },
  });
}

/**
 * Exchange a refresh token for a new session.
 *
 * Note the header: `refreshSession` authenticates with the **refresh** JWT, not the access
 * one. Sending the access token here fails with `ExpiredToken`, which reads like the
 * refresh itself expired and sends you looking in the wrong place.
 */
export async function refreshSession(
  context: ProviderCallContext,
  input: { pds?: string; refreshJwt: string },
): Promise<Session> {
  return call<Session>(context, {
    pds: input.pds,
    path: XRPC.refreshSession,
    method: 'POST',
    operation: 'refreshSession',
    accessJwt: input.refreshJwt,
  });
}

export interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

/**
 * Upload image bytes and receive a blob reference to embed.
 *
 * Raw bytes with the image's own Content-Type — not multipart, and not JSON. The response
 * blob must be embedded verbatim; reconstructing it by hand loses the CID link.
 */
export async function uploadBlob(
  context: ProviderCallContext,
  input: { pds?: string; accessJwt: string; bytes: ArrayBuffer; mimeType: string; timeoutMs?: number },
): Promise<BlobRef> {
  const response = await providerFetch(context, serviceUrl(input.pds, XRPC.uploadBlob), {
    operation: 'uploadBlob',
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessJwt}`,
      'content-type': input.mimeType,
    },
    body: input.bytes,
    timeoutMs: input.timeoutMs ?? 60_000,
  });

  if (!response.ok) {
    raise(response.status, response.headers, response.json, 'Blob upload failed.');
  }

  const body = response.json as { blob?: BlobRef };
  if (!body.blob) {
    throw new AtProtoError(response.status, 'InvalidResponse', 'uploadBlob returned no blob.');
  }
  return body.blob;
}

export interface CreateRecordResult {
  uri: string;
  cid: string;
}

export async function createRecord(
  context: ProviderCallContext,
  input: {
    pds?: string;
    accessJwt: string;
    repo: string;
    collection: string;
    record: Record<string, unknown>;
  },
): Promise<CreateRecordResult> {
  return call<CreateRecordResult>(context, {
    pds: input.pds,
    path: XRPC.createRecord,
    method: 'POST',
    operation: 'createRecord',
    accessJwt: input.accessJwt,
    body: { repo: input.repo, collection: input.collection, record: input.record },
  });
}

export async function deleteRecord(
  context: ProviderCallContext,
  input: { pds?: string; accessJwt: string; repo: string; collection: string; rkey: string },
): Promise<void> {
  await call(context, {
    pds: input.pds,
    path: XRPC.deleteRecord,
    method: 'POST',
    operation: 'deleteRecord',
    accessJwt: input.accessJwt,
    body: { repo: input.repo, collection: input.collection, rkey: input.rkey },
  });
}

export async function resolveHandle(
  context: ProviderCallContext,
  input: { pds?: string; handle: string },
): Promise<string | null> {
  try {
    const result = await call<{ did: string }>(context, {
      pds: input.pds,
      path: XRPC.resolveHandle,
      method: 'GET',
      operation: 'resolveHandle',
      query: { handle: input.handle },
    });
    return result.did;
  } catch (error) {
    // An unresolvable handle is a typo in the post text, not a failure to publish. The
    // mention degrades to plain text rather than blocking the post.
    if (error instanceof AtProtoError) return null;
    throw error;
  }
}

export interface FeedPost {
  post: {
    uri: string;
    cid: string;
    record: { text?: string; createdAt?: string };
    indexedAt: string;
  };
}

export async function getAuthorFeed(
  context: ProviderCallContext,
  input: { pds?: string; accessJwt: string; actor: string; limit?: number },
): Promise<FeedPost[]> {
  const result = await call<{ feed: FeedPost[] }>(context, {
    pds: input.pds,
    path: XRPC.getAuthorFeed,
    method: 'GET',
    operation: 'getAuthorFeed',
    accessJwt: input.accessJwt,
    query: { actor: input.actor, limit: String(input.limit ?? 30) },
  });
  return result.feed ?? [];
}

export interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

export async function getProfile(
  context: ProviderCallContext,
  input: { pds?: string; accessJwt: string; actor: string },
): Promise<Profile> {
  return call<Profile>(context, {
    pds: input.pds,
    path: XRPC.getProfile,
    method: 'GET',
    operation: 'getProfile',
    accessJwt: input.accessJwt,
    query: { actor: input.actor },
  });
}

/** `at://did:plc:abc/app.bsky.feed.post/3k...` → its record key. */
export function rkeyFromUri(uri: string): string | null {
  const match = /\/([^/]+)$/.exec(uri);
  return match?.[1] ?? null;
}

export { ProviderTimeoutError };
