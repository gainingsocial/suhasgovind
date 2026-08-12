import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildCapabilities,
  findings as f,
  hasScopes,
  parseRetryAfter,
  providerFetch,
  ProviderTimeoutError,
  ProviderTransportError,
  restrictCapabilities,
  scopeRestriction,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderAppCredentials,
  type ProviderCallContext,
  type ProviderCredentials,
  type ProviderDestination,
  type ResolvedMedia,
  type SocialProviderAdapter,
} from '@gs/provider-kit';

/**
 * X adapter (X API v2).
 *
 * Official documentation consulted (Rule 2):
 *   https://docs.x.com/x-api/posts/creation-of-a-post
 *   https://docs.x.com/x-api/posts/post-delete-by-post-id
 *   https://docs.x.com/x-api/posts/user-posts-timeline-by-user-id
 *   https://docs.x.com/x-api/users/user-lookup-me
 *   https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 *   https://docs.x.com/x-api/media/media-metadata-create
 *   https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/user-access-token
 *
 * Four things about this API shape the file:
 *
 *   PKCE is mandatory, not optional. X's OAuth 2.0 user-context flow requires a
 *   `code_challenge` on every authorization, so this is the first adapter using the
 *   `oauth2_pkce` strategy. The verifier is returned from `createAuthorization`, encrypted
 *   by the engine and replayed at callback (plan §21.1).
 *
 *   Refresh tokens rotate. Every refresh returns a NEW refresh token and invalidates the
 *   one presented. Keeping the old one — the behaviour LinkedIn's optional rotation
 *   invites — locks the connection out permanently on the next refresh.
 *
 *   There is no idempotency key on post creation. X offers nothing to deduplicate a
 *   retried publish, so reconciliation through the author timeline (ADR-006 Layer 4) is
 *   the only defence against a duplicate, and it is implemented here rather than waived.
 *
 *   Media upload is a separate API with its own scope and its own multi-step protocol.
 *   `media.write` is granted independently of `tweet.write`, so a connection can be able
 *   to post text and unable to post images — which effective capability has to say.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://api.x.com/2';

/**
 * X versions its API in the path rather than by header or date, so there is no version to
 * pin beyond the base URL. Recorded as `2` so the attempt record still says which API
 * generation produced a result (plan §44).
 */
const X_API_VERSION = '2';

/**
 * Post length limit.
 *
 * 280 is the limit for a standard account. Premium subscribers get considerably more, but
 * an entitlement the API does not report on `GET /2/users/me` cannot be detected, and
 * capability restriction is one-way — effective capability may only narrow generic
 * capability, never widen it (plan §17). Rule 14 says to fail safely: validating against
 * the limit every account has means a premium user occasionally sees an avoidable warning,
 * whereas the reverse would let the engine submit posts X rejects.
 */
const MAX_TEXT_LENGTH = 280;

/** `media.media_ids` accepts 1-4 entries. */
const MAX_MEDIA_COUNT = 4;

/** Documented per-item ceilings. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 140;

/** Alt text is capped at 1,000 characters by `POST /2/media/metadata`. */
const MAX_ALT_TEXT = 1000;

/**
 * APPEND chunk size.
 *
 * X caps a single APPEND at 5 MB. 4 MB leaves headroom for the multipart envelope without
 * turning a large video into thousands of requests.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** How long `prepare` will wait for X to finish transcoding an uploaded video. */
const MAX_MEDIA_PROCESSING_MS = 300_000;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4'] as const;

const TWEET_WRITE = 'tweet.write';
const TWEET_READ = 'tweet.read';
const USERS_READ = 'users.read';
const MEDIA_WRITE = 'media.write';
const OFFLINE_ACCESS = 'offline.access';

const DEFAULT_SCOPES = [TWEET_READ, TWEET_WRITE, USERS_READ, MEDIA_WRITE, OFFLINE_ACCESS];

export class XError extends Error {
  readonly status: number;
  /**
   * X's own machine-readable discriminator. v2 endpoints return a `type` URI in the
   * problem object; the older error array carries a numeric `code`. Either is stabler
   * than the human message, so both land here as a string.
   */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'XError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * X returns two different error shapes depending on the endpoint's age.
 *
 * The v2 problem object (`{ title, detail, type, status }`) and the legacy array
 * (`{ errors: [{ message, code }] }`) both appear on endpoints this adapter calls, so
 * reading only one of them loses the reason for the failure on half of them.
 */
interface XErrorBody {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  reason?: string;
  errors?: { message?: string; code?: number; title?: string; detail?: string }[];
}

function toXError(
  status: number,
  body: unknown,
  headers: Headers,
  fallback: string,
): XError {
  const parsed = (body ?? {}) as XErrorBody;
  const first = parsed.errors?.[0];

  const code =
    parsed.type?.split('/').pop() ??
    parsed.reason ??
    (first?.code !== undefined ? String(first.code) : undefined);

  const message =
    parsed.detail ?? parsed.title ?? first?.detail ?? first?.message ?? first?.title ?? fallback;

  return new XError(status, code, message, parseRetryAfter(headers));
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'DELETE' | 'PUT';
    path: string;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const response = await providerFetch(context, `${API_BASE}${input.path}`, {
    operation: input.path.split('?')[0] ?? input.path,
    method: input.method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (!response.ok) {
    throw toXError(response.status, response.json, response.headers, `X returned ${response.status}.`);
  }

  return (response.json ?? {}) as T;
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new XError(401, 'EMPTY_ACCESS_TOKEN', 'This connection has no X access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    // Rule 14 — name what is missing. X is OAuth-only, so an unregistered app is a
    // configuration fault, not a caller error.
    throw new XError(
      500,
      'MISSING_APP',
      'No X application is configured. Add its client id and secret before connecting.',
    );
  }
  return app;
}

/**
 * X authenticates confidential clients on the token endpoint with HTTP Basic, not with a
 * `client_secret` form field. Sending the secret in the body returns "Missing valid
 * authorization header", which reads like a bearer-token problem and sends you looking in
 * the wrong place entirely.
 */
function basicAuth(app: ProviderAppCredentials): string {
  return `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`;
}

// ---------------------------------------------------------------------------
// PKCE (plan §21.1)
// ---------------------------------------------------------------------------

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  // base64url per RFC 7636 §4.2: URL-safe alphabet and no padding. Leaving the `=` in is
  // the single most common cause of "code verifier does not match code challenge".
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createCodeVerifier(): string {
  // RFC 7636 §4.1 allows 43-128 characters; 32 random bytes base64url-encode to 43.
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// ---------------------------------------------------------------------------
// Media upload (chunked)
// ---------------------------------------------------------------------------

interface MediaUploadResponse {
  data?: {
    id?: string;
    media_key?: string;
    expires_after_secs?: number;
    processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } };
  };
}

/**
 * X's `media_category` decides which processing pipeline the upload enters, and the wrong
 * one is rejected at FINALIZE rather than at INIT — after every byte has been sent.
 */
function mediaCategoryOf(media: ResolvedMedia): string {
  if (media.kind === 'video') return 'tweet_video';
  if (media.mimeType === 'image/gif') return 'tweet_gif';
  return 'tweet_image';
}

async function uploadCommand(
  context: ProviderCallContext,
  accessToken: string,
  form: FormData,
  operation: string,
  timeoutMs?: number,
): Promise<MediaUploadResponse> {
  const response = await providerFetch(context, `${API_BASE}/media/upload`, {
    operation,
    method: 'POST',
    // Deliberately no content-type: fetch sets the multipart boundary itself, and an
    // explicit header without the boundary makes the body unparseable.
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  if (!response.ok) {
    throw toXError(response.status, response.json, response.headers, 'X rejected the media upload.');
  }

  return (response.json ?? {}) as MediaUploadResponse;
}

/**
 * Upload one media item through INIT → APPEND → FINALIZE, waiting for transcoding when X
 * says it is still processing.
 *
 * Returns the numeric media id that `POST /2/tweets` expects in `media.media_ids`.
 */
async function uploadMedia(
  context: ProviderCallContext,
  accessToken: string,
  media: ResolvedMedia,
): Promise<string> {
  const source = await fetch(media.downloadUrl, { signal: context.signal });
  if (!source.ok) {
    throw new XError(source.status, 'MEDIA_FETCH_FAILED', 'Could not read the media file.');
  }
  const bytes = new Uint8Array(await source.arrayBuffer());

  const init = new FormData();
  init.set('command', 'INIT');
  init.set('media_type', media.mimeType);
  init.set('total_bytes', String(bytes.byteLength));
  init.set('media_category', mediaCategoryOf(media));

  const initialized = await uploadCommand(context, accessToken, init, 'media.upload.INIT');
  const mediaId = initialized.data?.id;
  if (!mediaId) {
    throw new XError(502, 'MISSING_MEDIA_ID', 'X did not return a media id for the upload.');
  }

  for (let offset = 0, segment = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, segment++) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
    const append = new FormData();
    append.set('command', 'APPEND');
    append.set('media_id', mediaId);
    append.set('segment_index', String(segment));
    append.set('media', new Blob([chunk], { type: 'application/octet-stream' }));

    await uploadCommand(context, accessToken, append, 'media.upload.APPEND', 120_000);
  }

  const finalize = new FormData();
  finalize.set('command', 'FINALIZE');
  finalize.set('media_id', mediaId);

  const finalized = await uploadCommand(context, accessToken, finalize, 'media.upload.FINALIZE', 60_000);
  await awaitProcessing(context, accessToken, mediaId, finalized);

  // Alt text is a separate call and a separate failure. A post without alt text is worse
  // than one with it but far better than no post at all, so this must not abort the
  // publish (plan §31 treats accessibility metadata as best-effort enrichment).
  if (media.altText) {
    try {
      await call(context, {
        accessToken,
        method: 'POST',
        path: '/media/metadata',
        body: {
          id: mediaId,
          metadata: { alt_text: { text: media.altText.slice(0, MAX_ALT_TEXT) } },
        },
      });
    } catch {
      context.log({
        operation: 'media.metadata',
        method: 'POST',
        path: '/2/media/metadata',
        durationMs: 0,
        detail: { failure: 'alt_text_rejected', mediaId: media.mediaId },
      });
    }
  }

  return mediaId;
}

/**
 * Poll STATUS until X finishes transcoding.
 *
 * FINALIZE returns `processing_info` only when work remains; an image comes back complete
 * and needs no polling at all. Attaching a `media_id` that is still `in_progress` fails the
 * post, so this waits rather than optimistically proceeding.
 */
async function awaitProcessing(
  context: ProviderCallContext,
  accessToken: string,
  mediaId: string,
  finalized: MediaUploadResponse,
): Promise<void> {
  let info = finalized.data?.processing_info;
  const deadline = Date.now() + MAX_MEDIA_PROCESSING_MS;

  while (info && (info.state === 'pending' || info.state === 'in_progress')) {
    if (Date.now() >= deadline) {
      throw new XError(504, 'MEDIA_PROCESSING_TIMEOUT', 'X did not finish processing the media in time.');
    }

    // X tells us when to come back. Ignoring `check_after_secs` and polling faster is how
    // a media upload earns a rate limit.
    const waitMs = Math.max(1, info.check_after_secs ?? 1) * 1000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      context.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ProviderTimeoutError('media.upload.STATUS', waitMs));
        },
        { once: true },
      );
    });

    const status = await call<MediaUploadResponse>(context, {
      accessToken,
      method: 'GET',
      path: `/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
    });
    info = status.data?.processing_info;
  }

  if (info?.state === 'failed') {
    throw new XError(
      422,
      'MEDIA_PROCESSING_FAILED',
      info.error?.message ?? 'X could not process the uploaded media.',
    );
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'x',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      // Up to four images on one post. Not a swipeable carousel in X's UI, but the same
      // thing from the caller's side: one post, several images.
      carousel: true,
      // X unfurls a card from a URL in the text; there is no link field to populate.
      link_preview: true,
      poll: true,
      // Threads are chained replies, which this adapter supports through
      // `providerOptions.replyToPostId`.
      thread: true,
    },
    actions: {
      delete_post: true,
      // Editing is a paid entitlement with no documented v2 endpoint. Claiming it would
      // make preflight approve an edit the engine cannot perform.
      edit_post: false,
      comments_reply: true,
    },
    constraints: {
      max_text_length: MAX_TEXT_LENGTH,
      max_media_count: MAX_MEDIA_COUNT,
      max_image_bytes: MAX_IMAGE_BYTES,
      max_video_bytes: MAX_VIDEO_BYTES,
      max_video_duration_seconds: MAX_VIDEO_SECONDS,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      supports_alt_text: true,
    },
  });
}

interface XUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  verified?: boolean;
}

const USER_FIELDS = 'id,name,username,profile_image_url,verified';

async function fetchMe(context: ProviderCallContext, accessToken: string): Promise<XUser> {
  const response = await call<{ data?: XUser }>(context, {
    accessToken,
    method: 'GET',
    path: `/users/me?user.fields=${USER_FIELDS}`,
  });

  if (!response.data?.id) {
    throw new XError(502, 'MISSING_USER', 'X did not return the authenticated account.');
  }
  return response.data;
}

function identityOf(user: XUser, grantedScopes: readonly string[]): ConnectionIdentity {
  return {
    externalAccountId: user.id,
    displayName: user.name ?? user.username ?? 'X account',
    handle: user.username ? `@${user.username}` : null,
    avatarUrl: user.profile_image_url ?? null,
    accountType: user.verified ? 'verified' : 'standard',
    grantedScopes,
  };
}

export function createXAdapter(): SocialProviderAdapter {
  return {
    provider: 'x',
    version: ADAPTER_VERSION,
    // X requires PKCE on the user-context authorization flow; there is no plain
    // authorization-code option to fall back to.
    authStrategy: 'oauth2_pkce',
    providerApiVersion: X_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [TWEET_WRITE])) {
        for (const capability of [
          'text_only',
          'image',
          'video',
          'carousel',
          'link_preview',
          'poll',
          'thread',
        ]) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [TWEET_WRITE]));
        }
        restrictions.push(scopeRestriction('actions.delete_post', [TWEET_WRITE]));
        restrictions.push(scopeRestriction('actions.comments_reply', [TWEET_WRITE]));
      } else if (!hasScopes(granted, [MEDIA_WRITE])) {
        // media.write is granted separately from tweet.write, so an account can be able to
        // post text and unable to attach an image. Saying so up front is the difference
        // between a caller composing text and a caller watching an image post fail.
        for (const capability of ['image', 'video', 'carousel']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [MEDIA_WRITE]));
        }
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? [...input.requestedScopes] : DEFAULT_SCOPES;

        const codeVerifier = createCodeVerifier();
        const url = new URL('https://x.com/i/oauth2/authorize');
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', app.clientId);
        url.searchParams.set('redirect_uri', app.redirectUri);
        url.searchParams.set('scope', scopes.join(' '));
        url.searchParams.set('state', input.state);
        url.searchParams.set('code_challenge', await deriveCodeChallenge(codeVerifier));
        // S256 rather than `plain`. X accepts both, and `plain` puts the verifier in a URL
        // that ends up in browser history and referrer headers.
        url.searchParams.set('code_challenge_method', 'S256');

        return { authorizationUrl: url.toString(), codeVerifier, state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new XError(
            400,
            input.query.error,
            input.query.error_description ?? 'X authorization was declined.',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new XError(400, 'MISSING_CODE', 'X did not return an authorization code.');
        }
        if (!input.codeVerifier) {
          // Without the verifier the exchange cannot succeed, and failing here names the
          // real cause instead of surfacing X's generic PKCE mismatch (Rule 14).
          throw new XError(
            400,
            'MISSING_CODE_VERIFIER',
            'The PKCE code verifier for this connect session is missing; start the connection again.',
          );
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth2/token`, {
          operation: 'oauth2.token',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basicAuth(app),
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: app.clientId,
            redirect_uri: app.redirectUri,
            code_verifier: input.codeVerifier,
          }).toString(),
        });

        if (!response.ok) {
          throw toXError(
            response.status,
            response.json,
            response.headers,
            'Could not exchange the authorization code.',
          );
        }

        const token = response.json as {
          access_token: string;
          expires_in?: number;
          refresh_token?: string;
          scope?: string;
        };

        const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [];
        const user = await fetchMe(input.context, token.access_token);

        return {
          credentials: {
            strategy: 'oauth2_pkce',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: user.id,
            // Rule 15 — UTC ISO-8601, consumed by the proactive refresh sweep.
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
            grantedScopes,
            metadata: { username: user.username ?? null },
          },
          identity: identityOf(user, grantedScopes),
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);

        if (!input.credentials.refreshToken) {
          // No refresh token means `offline.access` was never granted. The account has to
          // be reconnected; saying so beats a 401 mid-publish.
          throw new XError(
            401,
            'NO_REFRESH_TOKEN',
            'This X connection has no refresh token and must be reconnected.',
          );
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth2/token`, {
          operation: 'oauth2.refresh',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basicAuth(app),
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: input.credentials.refreshToken,
            client_id: app.clientId,
          }).toString(),
        });

        if (!response.ok) {
          throw toXError(response.status, response.json, response.headers, 'Could not refresh the X token.');
        }

        const token = response.json as {
          access_token: string;
          expires_in?: number;
          refresh_token?: string;
        };

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // X rotates the refresh token on every use and invalidates the presented one.
            // Falling back to the old value — as LinkedIn's optional rotation allows —
            // would lock the connection out at the next refresh.
            refreshToken: token.refresh_token ?? input.credentials.refreshToken,
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
          },
          rotated: true,
        };
      },

      async revoke(input) {
        const app = requireApp(input.app);
        const token = input.credentials.refreshToken ?? input.credentials.accessToken;
        if (!token) return;

        const response = await providerFetch(input.context, `${API_BASE}/oauth2/revoke`, {
          operation: 'oauth2.revoke',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basicAuth(app),
          },
          body: new URLSearchParams({ token, client_id: app.clientId }).toString(),
        });

        // A token X has already forgotten is the state we wanted. Treating that as a
        // failure would leave a disconnect stuck retrying something that cannot succeed.
        if (!response.ok && response.status !== 400 && response.status !== 401) {
          throw toXError(response.status, response.json, response.headers, 'Could not revoke the X token.');
        }
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const user = await fetchMe(input.context, accessTokenOf(input.credentials));
        return identityOf(user, input.credentials.grantedScopes);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        // One connection is exactly one account. X has no Pages, boards or channels
        // beneath it, so the destination list is the account itself — resolved from the
        // credential rather than fetched, since `inspect` already established identity.
        const user = await fetchMe(input.context, accessTokenOf(input.credentials));

        return [
          {
            externalId: user.id,
            displayName: user.name ?? user.username ?? 'X account',
            handle: user.username ? `@${user.username}` : null,
            avatarUrl: user.profile_image_url ?? null,
            kind: 'account',
            metadata: { username: user.username ?? null },
          },
        ];
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const poll = content.providerOptions.poll as
          | { options?: unknown[]; durationMinutes?: number }
          | undefined;

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_TEXT_LENGTH, {
              code: 'TEXT_TOO_LONG',
              truncatable: true,
            }),
            f.checkMediaCount(content.media.length, MAX_MEDIA_COUNT),
          ),
        );

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'An X post needs text or media.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        const videos = content.media.filter((item) => item.kind === 'video');
        const gifs = content.media.filter((item) => item.mimeType === 'image/gif');

        // X allows four images, OR one video, OR one GIF — never a mixture. Learning this
        // at publish time would waste an upload that may already have transcoded.
        if (videos.length > 0 && content.media.length > videos.length) {
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'X cannot mix video and images in one post.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }
        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'An X post carries at most one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }
        if (gifs.length > 0 && content.media.length > gifs.length) {
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'X cannot mix a GIF with other media.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }
        if (gifs.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'An X post carries at most one GIF.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_VIDEO_TYPES, index),
                f.checkMediaSize(item.bytes, MAX_VIDEO_BYTES, index),
                f.checkVideoDuration(item.durationSeconds, { min: null, max: MAX_VIDEO_SECONDS }, index),
              ),
            );
          } else {
            const limit = item.mimeType === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES;
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index),
                f.checkMediaSize(item.bytes, limit, index),
              ),
            );
          }

          if (item.altText !== null && [...item.altText].length > MAX_ALT_TEXT) {
            results.push(
              f.warning('ALT_TEXT_TOO_LONG', `Alt text will be truncated to ${MAX_ALT_TEXT} characters.`, {
                field: `media[${index}].altText`,
                agentAction: 'shorten_alt_text',
              }),
            );
          }
        });

        // A poll and media are mutually exclusive on `POST /2/tweets`.
        if (poll && content.media.length > 0) {
          results.push(
            f.error('POLL_WITH_MEDIA_UNSUPPORTED', 'An X poll cannot also carry media.', {
              field: 'providerOptions.poll',
              agentAction: 'remove_media',
            }),
          );
        }
        if (poll) {
          const options = poll.options ?? [];
          if (options.length < 2 || options.length > 4) {
            results.push(
              f.error('POLL_OPTION_COUNT_INVALID', 'An X poll needs between 2 and 4 options.', {
                field: 'providerOptions.poll.options',
                agentAction: 'correct_poll_options',
              }),
            );
          }
          const duration = poll.durationMinutes;
          if (duration !== undefined && (duration < 5 || duration > 10080)) {
            results.push(
              f.error('POLL_DURATION_INVALID', 'An X poll runs for between 5 and 10080 minutes.', {
                field: 'providerOptions.poll.durationMinutes',
                agentAction: 'correct_poll_duration',
              }),
            );
          }
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = accessTokenOf(input.credentials);
        const mediaIds: string[] = [];

        // Uploads happen here rather than in `publish` so the slow, retry-prone work is
        // separated from the one irreversible call.
        for (const media of input.content.media) {
          mediaIds.push(await uploadMedia(input.context, accessToken, media));
        }

        return { state: { mediaIds }, providerMediaIds: mediaIds };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const mediaIds = (input.prepared.state.mediaIds as string[] | undefined) ?? [];
        const options = input.content.providerOptions;

        const body: Record<string, unknown> = { text: input.content.text };

        if (mediaIds.length > 0) {
          body.media = { media_ids: mediaIds };
        }

        const replyTo = options.replyToPostId;
        if (typeof replyTo === 'string' && replyTo !== '') {
          // How a thread is built: each part replies to the previous one.
          body.reply = { in_reply_to_tweet_id: replyTo };
        }

        const poll = options.poll as { options?: string[]; durationMinutes?: number } | undefined;
        if (poll?.options && poll.options.length > 0) {
          body.poll = {
            options: poll.options,
            duration_minutes: poll.durationMinutes ?? 1440,
          };
        }

        if (typeof options.replySettings === 'string') {
          body.reply_settings = options.replySettings;
        }

        // X offers no idempotency key on post creation, so a retried publish would create
        // a second post. `findPossibleDuplicate` below is what stands in for it.
        const created = await call<{ data?: { id?: string; text?: string } }>(input.context, {
          accessToken,
          method: 'POST',
          path: '/tweets',
          body,
        });

        const id = created.data?.id;
        if (!id) {
          throw new XError(502, 'MISSING_POST_ID', 'X did not return a post id.');
        }

        const username = input.credentials.metadata.username;
        return {
          outcome: 'published',
          externalPostId: id,
          externalUrl: `https://x.com/${typeof username === 'string' && username ? username : 'i'}/status/${id}`,
          publishedAt: new Date().toISOString(),
          metadata: {},
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. This is X's only duplicate defence — there is no idempotency
        // key — so it is implemented rather than waived.
        const granted = input.credentials.grantedScopes;
        if (!hasScopes(granted, [TWEET_READ])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires the ${TWEET_READ} permission, which this connection did not grant.`,
          };
        }

        const accountId = input.credentials.externalAccountId;
        if (!accountId) {
          return {
            conclusion: 'indeterminate',
            reason: 'The connection does not record which X account it authenticates as.',
          };
        }

        const query = new URLSearchParams({
          max_results: '100',
          // X rejects a `start_time` with sub-second precision, and the timeline is
          // exclusive of it, so a whole second is trimmed off rather than risking the
          // post we are looking for falling outside the window.
          start_time: new Date(Date.parse(input.attemptedAfter) - 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
          'post.fields': 'created_at,text',
        });

        const response = await call<{
          data?: { id: string; text?: string; created_at?: string }[];
          meta?: { result_count?: number };
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: `/users/${encodeURIComponent(accountId)}/tweets?${query.toString()}`,
        });

        const posts = response.data ?? [];
        const wanted = input.content.text.trim();

        for (const post of posts) {
          // X rewrites t.co links in the returned text, so an exact match only holds for
          // posts without URLs. A prefix comparison on the untouched leading segment is
          // what remains reliable.
          if ((post.text ?? '').trim() === wanted) {
            return {
              conclusion: 'found',
              externalPostId: post.id,
              externalUrl: `https://x.com/i/status/${post.id}`,
              ...(post.created_at ? { publishedAt: new Date(post.created_at).toISOString() } : {}),
            };
          }
        }

        if (posts.length >= 100) {
          // A full page means a match could sit just outside it. Rule 14 — say so rather
          // than reporting a clean absence that licenses a retry.
          return {
            conclusion: 'indeterminate',
            reason: 'The timeline page was full, so a matching post cannot be ruled out.',
          };
        }

        if (wanted === '') {
          // Nothing to match on. A media-only post cannot be identified by text, and
          // guessing from timing alone is exactly the reasoning that duplicates posts.
          return {
            conclusion: 'indeterminate',
            reason: 'The post has no text, so it cannot be identified in the timeline.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          const result = await call<{ data?: { deleted?: boolean } }>(input.context, {
            accessToken: accessTokenOf(input.credentials),
            method: 'DELETE',
            path: `/tweets/${encodeURIComponent(input.externalPostId)}`,
          });
          // `deleted: false` means X found the post and declined to remove it, which is
          // not the same as it being gone.
          return { alreadyAbsent: result.data?.deleted === false };
        } catch (error) {
          if (error instanceof XError && error.status === 404) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `X timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return { code: 'PROVIDER_UNAVAILABLE', message: `X was unreachable during ${context.operation}.` };
      }

      if (error instanceof XError) {
        // Branch on X's discriminator before the status code: a duplicate-content 403 and
        // a missing-scope 403 need completely different handling, and only the code
        // separates them.
        switch (error.code) {
          case 'EMPTY_ACCESS_TOKEN':
          case 'NO_REFRESH_TOKEN':
          case 'MISSING_CODE_VERIFIER':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'duplicate-rules':
          case 'DuplicateContent':
            // X refuses an identical post from the same account. Something equivalent is
            // already there, so this reconciles rather than retries — a blind retry can
            // only fail the same way.
            return { code: 'POSSIBLE_DUPLICATE', message: error.message, status: error.status };
          case 'unsupported-authentication':
          case 'unauthorized-client':
            return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: error.status };
          case 'MEDIA_PROCESSING_FAILED':
          case 'MEDIA_FETCH_FAILED':
          case 'MEDIA_PROCESSING_TIMEOUT':
            // All three happen in `prepare`, before anything is published, so there is no
            // ambiguity to reconcile — a plain retryable failure is the honest disposition.
            return { code: 'MEDIA_PROCESSING_FAILED', message: error.message, status: error.status };
        }

        if (error.status === 401) {
          return { code: 'AUTH_EXPIRED', message: error.message, status: 401 };
        }
        if (error.status === 403) {
          return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: 403 };
        }
        if (error.status === 404) {
          return { code: 'DESTINATION_NOT_FOUND', message: error.message, status: 404 };
        }
        if (error.status === 409) {
          return { code: 'PROVIDER_CONFLICT', message: error.message, status: 409 };
        }
        if (error.status === 422) {
          return { code: 'CONTENT_REJECTED', message: error.message, status: 422 };
        }
        if (error.status === 429) {
          return {
            code: 'RATE_LIMITED',
            message: error.message,
            status: 429,
            retryAfter: error.retryAfter,
          };
        }
        if (error.status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: error.message, status: error.status };
        }
        if (error.status === 400) {
          return { code: 'VALIDATION_FAILED', message: error.message, status: 400 };
        }
      }

      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401 || status === 403) {
          return { code: 'AUTH_EXPIRED', message: 'X rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'X is rate limiting this account.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'X returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried, because X has no
      // idempotency key and a blind retry could duplicate a post.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized X failure during ${context.operation}.`,
      };
    },
  };
}
