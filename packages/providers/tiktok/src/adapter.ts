import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  approvalRestriction,
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
  type SocialProviderAdapter,
} from '@gs/provider-kit';

/**
 * TikTok adapter (Content Posting API — Direct Post).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *   https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 *   https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *   https://developers.tiktok.com/doc/content-sharing-guidelines
 *   https://developers.tiktok.com/doc/oauth-user-access-token-management
 *   https://developers.tiktok.com/doc/tiktok-api-v2-video-list
 *
 * Five things about this API shape the file:
 *
 *   HTTP 200 does not mean success. Every response carries an `error` object, and a
 *   successful call is the one where `error.code === 'ok'`. Checking `response.ok` alone
 *   reports a rejected post as published — the single worst failure this adapter could
 *   have, because the post never appears and nothing retries.
 *
 *   Audit state changes what may be published, not merely whether it works. Plan §63:
 *   an unaudited client is confined to private (`SELF_ONLY`) posting. That is a capability
 *   fact, so it is surfaced through `capabilities()` rather than discovered when a post
 *   silently lands as private. Until the audit is recorded on the provider app, this
 *   adapter assumes unaudited — Rule 14, fail safely.
 *
 *   `privacy_level` has no default. TikTok's content-sharing guidelines require the
 *   creator to choose, from the options `creator_info` reports for that specific account,
 *   and reject the request outright when it is absent. Hence `PRIVACY_SELECTION_REQUIRED`
 *   in the shared taxonomy.
 *
 *   `client_key`, not `client_id`. TikTok departs from OAuth 2.0 naming on the parameter
 *   every other provider spells the same way.
 *
 *   Publishing is asynchronous and two-phased. `init` returns a `publish_id`, TikTok then
 *   downloads and transcodes, and only `status/fetch` says whether a post exists. So
 *   `publish` returns `processing` and the poller finishes the job.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://open.tiktokapis.com/v2';

/** TikTok versions in the path; there is no version header to pin. */
const TIKTOK_API_VERSION = 'v2';

/** Caption ceiling. TikTok calls it `title` on both the video and photo endpoints. */
const MAX_TITLE = 2200;

/** A photo post carries up to ten images. */
const MAX_PHOTOS = 10;

/**
 * Generic video ceiling.
 *
 * Per-creator reality is whatever `creator_info.max_video_post_duration_sec` reports, and
 * that is what `prepare` enforces. This is only the platform-wide figure used before a
 * connection is in hand.
 */
const MAX_VIDEO_SECONDS = 600;

/** PNG is rejected by the photo endpoint; JPEG and WebP are the accepted types. */
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/webp'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4'] as const;

const PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

const SCOPE_PUBLISH = 'video.publish';
const SCOPE_UPLOAD = 'video.upload';
const SCOPE_USER_INFO = 'user.info.basic';
/** Display API scope. Optional, and the only thing that makes reconciliation provable. */
const SCOPE_VIDEO_LIST = 'video.list';

const DEFAULT_SCOPES = [SCOPE_USER_INFO, SCOPE_PUBLISH, SCOPE_UPLOAD, SCOPE_VIDEO_LIST];

/**
 * Marks the provider app as having passed TikTok's audit.
 *
 * Set on the `provider_apps` row once the audit is granted (plan §23, §63). Absent means
 * unaudited, which is the safe assumption: over-restricting shows a caller an explained
 * limitation, while under-restricting publishes what the caller believes is a public post
 * into a private one.
 */
const AUDITED_KEY = 'audited';

export class TikTokError extends Error {
  readonly status: number;
  /** TikTok's own `error.code`, e.g. `spam_risk_too_many_pending_share`. */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;
  /** TikTok's `log_id`. The first thing their support asks for. */
  readonly logId: string | undefined;

  constructor(
    status: number,
    code: string | undefined,
    message: string,
    options: { retryAfter?: string; logId?: string } = {},
  ) {
    super(message);
    this.name = 'TikTokError';
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.logId = options.logId;
  }
}

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * Call TikTok and unwrap the envelope.
 *
 * The `error.code === 'ok'` check is the load-bearing line: TikTok returns HTTP 200 with a
 * populated `error` object for most rejections, so trusting the status code alone reports
 * failures as successes.
 */
async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST';
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
      ...(input.body !== undefined ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  const envelope = (response.json ?? {}) as TikTokEnvelope<T>;
  const error = envelope.error;

  if (!response.ok || (error?.code !== undefined && error.code !== 'ok')) {
    throw new TikTokError(
      response.status,
      error?.code,
      error?.message ?? `TikTok returned ${response.status}.`,
      { retryAfter: parseRetryAfter(response.headers), logId: error?.log_id },
    );
  }

  return (envelope.data ?? {}) as T;
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new TikTokError(401, 'access_token_invalid', 'This connection has no TikTok access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    throw new TikTokError(
      500,
      'MISSING_APP',
      'No TikTok application is configured. Add its client key and secret before connecting.',
    );
  }
  return app;
}

/** True only when the operator has recorded that TikTok granted the audit. */
function isAudited(app: ProviderAppCredentials | null): boolean {
  return app?.metadata[AUDITED_KEY] === true;
}

// ---------------------------------------------------------------------------
// PKCE (plan §21.1)
// ---------------------------------------------------------------------------

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createCodeVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// ---------------------------------------------------------------------------
// Creator info (plan §17 — effective capability, and a hard precondition)
// ---------------------------------------------------------------------------

/**
 * What TikTok reports about the connected creator.
 *
 * Every field here can differ per account and per day: a creator can switch to private,
 * turn off duet, or have a shorter maximum video length than the platform ceiling. The
 * content-sharing guidelines require the client to respect these values rather than the
 * generic limits, which is why `prepare` queries this before every post rather than
 * caching it onto the connection.
 */
interface CreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

async function queryCreatorInfo(
  context: ProviderCallContext,
  accessToken: string,
): Promise<CreatorInfo> {
  return call<CreatorInfo>(context, {
    accessToken,
    method: 'POST',
    path: '/post/publish/creator_info/query/',
    // Documented as a POST with no body; the content-type header is still required.
    body: {},
  });
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'tiktok',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      // TikTok has no text-only post. Every post is a video or a photo set, so preflight
      // must reject text alone rather than let the engine discover it at init.
      video: true,
      image: true,
      carousel: true,
    },
    actions: {
      // The Content Posting API publishes and reports status. It does not delete, edit,
      // or read comments — claiming otherwise would offer endpoints the engine cannot
      // fulfil.
      analytics_read: false,
    },
    constraints: {
      max_text_length: MAX_TITLE,
      max_media_count: MAX_PHOTOS,
      max_video_duration_seconds: MAX_VIDEO_SECONDS,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      allowed_privacy_levels: PRIVACY_LEVELS,
      // TikTok's posting API accepts no per-image alt text.
      supports_alt_text: false,
    },
  });
}

interface TikTokUser {
  open_id?: string;
  union_id?: string;
  display_name?: string;
  username?: string;
  avatar_url?: string;
}

const USER_FIELDS = 'open_id,union_id,display_name,username,avatar_url';

async function fetchUser(context: ProviderCallContext, accessToken: string): Promise<TikTokUser> {
  const data = await call<{ user?: TikTokUser }>(context, {
    accessToken,
    method: 'GET',
    path: `/user/info/?fields=${USER_FIELDS}`,
  });

  if (!data.user?.open_id) {
    throw new TikTokError(502, 'MISSING_USER', 'TikTok did not return the authenticated creator.');
  }
  return data.user;
}

function identityOf(user: TikTokUser, grantedScopes: readonly string[]): ConnectionIdentity {
  return {
    externalAccountId: user.open_id ?? '',
    displayName: user.display_name ?? user.username ?? 'TikTok creator',
    handle: user.username ? `@${user.username}` : null,
    avatarUrl: user.avatar_url ?? null,
    accountType: 'creator',
    grantedScopes,
  };
}

export function createTikTokAdapter(): SocialProviderAdapter {
  return {
    provider: 'tiktok',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2_pkce',
    providerApiVersion: TIKTOK_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [SCOPE_PUBLISH])) {
        for (const capability of ['video', 'image', 'carousel']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_PUBLISH]));
        }
      }

      const audited = isAudited(context.app);
      if (!audited) {
        // Plan §63, and the reason `approvalRestriction` exists. This does not stop the
        // post — it narrows what privacy levels are honestly available, so a caller finds
        // out before publishing rather than by looking for a post nobody else can see.
        restrictions.push(
          approvalRestriction(
            'constraints.allowed_privacy_levels',
            'This TikTok client has not passed the platform audit, so posts can only be published privately (SELF_ONLY).',
          ),
        );
      }

      const effective = restrictCapabilities(generic, restrictions);
      if (audited) return effective;

      // `restrictCapabilities` narrows booleans; the privacy list has to be narrowed here.
      return {
        ...effective,
        constraints: { ...effective.constraints, allowed_privacy_levels: ['SELF_ONLY'] },
      };
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? [...input.requestedScopes] : DEFAULT_SCOPES;

        const codeVerifier = createCodeVerifier();
        const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
        // `client_key`, not `client_id`. TikTok is the one provider that renames it, and
        // sending `client_id` produces an error about an unregistered application.
        url.searchParams.set('client_key', app.clientId);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', scopes.join(','));
        url.searchParams.set('redirect_uri', app.redirectUri);
        url.searchParams.set('state', input.state);
        url.searchParams.set('code_challenge', await deriveCodeChallenge(codeVerifier));
        url.searchParams.set('code_challenge_method', 'S256');

        return { authorizationUrl: url.toString(), codeVerifier, state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new TikTokError(
            400,
            input.query.error,
            input.query.error_description ?? 'TikTok authorization was declined.',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new TikTokError(400, 'MISSING_CODE', 'TikTok did not return an authorization code.');
        }
        if (!input.codeVerifier) {
          throw new TikTokError(
            400,
            'MISSING_CODE_VERIFIER',
            'The PKCE code verifier for this connect session is missing; start the connection again.',
          );
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth/token/`, {
          operation: 'oauth.token',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: app.clientId,
            client_secret: app.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: app.redirectUri,
            code_verifier: input.codeVerifier,
          }).toString(),
        });

        const token = (response.json ?? {}) as {
          access_token?: string;
          expires_in?: number;
          refresh_token?: string;
          refresh_expires_in?: number;
          open_id?: string;
          scope?: string;
          error?: string;
          error_description?: string;
        };

        // The token endpoint reports failure in the body, flat rather than under `error`.
        if (!response.ok || !token.access_token) {
          throw new TikTokError(
            response.status,
            token.error ?? 'TOKEN_EXCHANGE_FAILED',
            token.error_description ?? 'Could not exchange the authorization code.',
          );
        }

        const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [];
        const user = await fetchUser(input.context, token.access_token);

        return {
          credentials: {
            strategy: 'oauth2_pkce',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: token.open_id ?? user.open_id,
            // Access tokens last about a day, so the refresh sweep matters more here than
            // for providers issuing 60-day tokens (Rule 15 — UTC ISO-8601).
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
          throw new TikTokError(
            401,
            'NO_REFRESH_TOKEN',
            'This TikTok connection has no refresh token and must be reconnected.',
          );
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth/token/`, {
          operation: 'oauth.refresh',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: app.clientId,
            client_secret: app.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: input.credentials.refreshToken,
          }).toString(),
        });

        const token = (response.json ?? {}) as {
          access_token?: string;
          expires_in?: number;
          refresh_token?: string;
          error?: string;
          error_description?: string;
        };

        if (!response.ok || !token.access_token) {
          throw new TikTokError(
            response.status,
            token.error ?? 'REFRESH_FAILED',
            token.error_description ?? 'Could not refresh the TikTok token.',
          );
        }

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // TikTok rotates the refresh token, and the refresh token itself expires after
            // a year — so a connection left idle that long needs reconnecting, not
            // refreshing.
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
        const token = input.credentials.accessToken;
        if (!token) return;

        const response = await providerFetch(input.context, `${API_BASE}/oauth/revoke/`, {
          operation: 'oauth.revoke',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: app.clientId,
            client_secret: app.clientSecret,
            token,
          }).toString(),
        });

        // A token TikTok has already forgotten is the state we wanted.
        if (!response.ok && response.status !== 400 && response.status !== 401) {
          throw new TikTokError(response.status, 'REVOKE_FAILED', 'Could not revoke the TikTok token.');
        }
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const user = await fetchUser(input.context, accessTokenOf(input.credentials));
        return identityOf(user, input.credentials.grantedScopes);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        // One connection is one creator account. TikTok has no Pages or channels beneath
        // it, so the destination is the account itself.
        const user = await fetchUser(input.context, accessTokenOf(input.credentials));

        return [
          {
            externalId: user.open_id ?? '',
            displayName: user.display_name ?? user.username ?? 'TikTok creator',
            handle: user.username ? `@${user.username}` : null,
            avatarUrl: user.avatar_url ?? null,
            kind: 'creator',
            metadata: { username: user.username ?? null },
          },
        ];
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here. The per-creator limits
        // that only `creator_info` knows are checked in `prepare`.
        const { content } = input;
        const results: ValidationFinding[] = [];

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_TITLE, { code: 'TEXT_TOO_LONG', truncatable: true }),
          ),
        );

        const videos = content.media.filter((item) => item.kind === 'video');
        const images = content.media.filter((item) => item.kind === 'image');

        if (content.media.length === 0) {
          // TikTok has no text-only post. Failing here saves a round trip that can only
          // ever be rejected.
          results.push(
            f.error('MEDIA_REQUIRED', 'A TikTok post needs a video or at least one photo.', {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }

        if (videos.length > 0 && images.length > 0) {
          // Video and photo posts go to different endpoints entirely.
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'TikTok cannot mix a video and photos in one post.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }
        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'A TikTok post carries at most one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }
        if (images.length > 0) {
          results.push(...f.collect(f.checkMediaCount(images.length, MAX_PHOTOS)));
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_VIDEO_TYPES, index),
                f.checkVideoDuration(item.durationSeconds, { min: null, max: MAX_VIDEO_SECONDS }, index),
              ),
            );
          } else {
            // PNG is rejected by the photo endpoint. Catching it here rather than at init
            // is the difference between a clear finding and `picture_size_check_failed`.
            results.push(...f.collect(f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index)));
          }
        });

        // TikTok's content-sharing guidelines require an explicit privacy choice and
        // reject a request without one. There is no default to fall back on.
        const privacy = content.providerOptions.privacyLevel;
        if (typeof privacy !== 'string' || privacy === '') {
          results.push(
            f.error('PRIVACY_LEVEL_REQUIRED', 'TikTok requires an explicit privacy level for every post.', {
              field: 'providerOptions.privacyLevel',
              agentAction: 'choose_a_privacy_level',
            }),
          );
        } else if (!(PRIVACY_LEVELS as readonly string[]).includes(privacy)) {
          results.push(
            f.error('PRIVACY_LEVEL_INVALID', `"${privacy}" is not a TikTok privacy level.`, {
              field: 'providerOptions.privacyLevel',
              agentAction: 'choose_a_privacy_level',
            }),
          );
        } else if (!isAudited(input.app) && privacy !== 'SELF_ONLY') {
          // Plan §63. Publishing this would produce a post the creator believes is public
          // and nobody else can see.
          results.push(
            f.error(
              'PRIVACY_LEVEL_NOT_PERMITTED',
              'This TikTok client has not passed the platform audit, so posts can only be published privately (SELF_ONLY).',
              {
                field: 'providerOptions.privacyLevel',
                agentAction: 'await_platform_approval',
              },
            ),
          );
        }

        // Branded content cannot be private: TikTok requires a paid partnership to be
        // visible to be disclosed at all.
        const brandedContent = content.compliance.brandedContent === true;
        if (brandedContent && privacy === 'SELF_ONLY') {
          results.push(
            f.error(
              'BRANDED_CONTENT_CANNOT_BE_PRIVATE',
              'TikTok does not allow branded content to be posted privately.',
              {
                field: 'compliance.brandedContent',
                agentAction: 'choose_a_public_privacy_level',
              },
            ),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = accessTokenOf(input.credentials);

        // `creator_info` is a precondition, not an optimisation: TikTok's guidelines
        // require the client to respect the values it returns, and they are per-creator
        // and per-day. Enforcing them here means a violation is a clean failure rather
        // than a rejected init.
        const creator = await queryCreatorInfo(input.context, accessToken);

        const privacy = input.content.providerOptions.privacyLevel;
        const allowed = creator.privacy_level_options ?? [];
        if (typeof privacy === 'string' && allowed.length > 0 && !allowed.includes(privacy)) {
          throw new TikTokError(
            400,
            'privacy_level_not_available',
            `This creator cannot post at "${privacy}". Available: ${allowed.join(', ')}.`,
          );
        }

        const maxSeconds = creator.max_video_post_duration_sec;
        if (maxSeconds !== undefined) {
          for (const media of input.content.media) {
            if (media.kind !== 'video' || media.durationSeconds === null) continue;
            if (media.durationSeconds > maxSeconds) {
              throw new TikTokError(
                400,
                'duration_check_failed',
                `This creator can post videos up to ${maxSeconds}s; this one is ${media.durationSeconds}s.`,
              );
            }
          }
        }

        // Nothing is uploaded here. TikTok pulls the bytes itself during `init`, so there
        // is no provider-side object to record — which is exactly why reconciliation below
        // cannot be made provable without the Display API.
        return {
          state: {
            commentDisabled: creator.comment_disabled === true,
            duetDisabled: creator.duet_disabled === true,
            stitchDisabled: creator.stitch_disabled === true,
          },
          providerMediaIds: [],
        };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const options = input.content.providerOptions;
        const state = input.prepared.state;
        const videos = input.content.media.filter((item) => item.kind === 'video');

        const postInfo: Record<string, unknown> = {
          title: input.content.text,
          privacy_level: options.privacyLevel,
          // A creator who has turned an interaction off must not have it re-enabled by us;
          // `creator_info` said so during prepare.
          disable_comment: state.commentDisabled === true || options.disableComment === true,
          brand_content_toggle: input.content.compliance.brandedContent === true,
          brand_organic_toggle: input.content.compliance.ownBrand === true,
        };

        let path: string;
        let body: Record<string, unknown>;

        if (videos.length > 0) {
          const video = videos[0]!;
          postInfo.disable_duet = state.duetDisabled === true || options.disableDuet === true;
          postInfo.disable_stitch = state.stitchDisabled === true || options.disableStitch === true;
          if (typeof options.coverTimestampMs === 'number') {
            postInfo.video_cover_timestamp_ms = options.coverTimestampMs;
          }

          path = '/post/publish/video/init/';
          body = {
            post_info: postInfo,
            // PULL_FROM_URL requires the media host to be verified in TikTok's developer
            // portal; an unverified prefix fails with `url_ownership_unverified` before a
            // byte moves. That verification is tracked in PLATFORM_APPROVALS.md.
            source_info: { source: 'PULL_FROM_URL', video_url: video.downloadUrl },
          };
        } else {
          const images = input.content.media.filter((item) => item.kind === 'image');
          path = '/post/publish/content/init/';
          body = {
            post_info: postInfo,
            source_info: {
              source: 'PULL_FROM_URL',
              photo_cover_index: 0,
              photo_images: images.map((item) => item.downloadUrl),
            },
            // Both are required on the photo endpoint. Omitting `post_mode` files the
            // photos as a draft in the creator's inbox instead of publishing them.
            post_mode: 'DIRECT_POST',
            media_type: 'PHOTO',
          };
        }

        const created = await call<{ publish_id?: string }>(input.context, {
          accessToken,
          method: 'POST',
          path,
          body,
        });

        const publishId = created.publish_id;
        if (!publishId) {
          throw new TikTokError(502, 'MISSING_PUBLISH_ID', 'TikTok did not return a publish id.');
        }

        // Always asynchronous: TikTok has only accepted the request at this point. It
        // still has to download the media, transcode it and run its checks, and any of
        // those can fail. Reporting `published` here would mark a post live that may never
        // appear.
        return {
          outcome: 'processing',
          externalPostId: publishId,
          externalUrl: null,
          publishedAt: null,
          statusHandle: publishId,
          metadata: {},
        };
      },

      async status(input) {
        const data = await call<{
          status?: string;
          fail_reason?: string;
          publicaly_available_post_id?: string[];
          publicly_available_post_id?: string[];
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'POST',
          path: '/post/publish/status/fetch/',
          body: { publish_id: input.statusHandle },
        });

        // TikTok ships this field misspelled. Reading both spellings costs nothing and
        // survives the day they fix it (Rule 14).
        const postId = (data.publicaly_available_post_id ?? data.publicly_available_post_id ?? [])[0];
        const username = input.credentials.metadata.username;

        switch (data.status) {
          case 'PUBLISH_COMPLETE':
            return {
              outcome: 'published',
              externalPostId: postId ?? input.statusHandle,
              externalUrl:
                postId && typeof username === 'string' && username
                  ? `https://www.tiktok.com/@${username}/video/${postId}`
                  : null,
              publishedAt: new Date().toISOString(),
            };
          case 'FAILED':
            return {
              outcome: 'failed',
              externalPostId: null,
              externalUrl: null,
              publishedAt: null,
              failureReason: data.fail_reason ?? 'TikTok rejected the post during processing.',
            };
          default:
            // PROCESSING_DOWNLOAD, PROCESSING_UPLOAD, SEND_TO_USER_INBOX — all still
            // in flight. SEND_TO_USER_INBOX in particular means the creator has to
            // confirm in the app, which can take arbitrarily long.
            return { outcome: 'processing', externalPostId: null, externalUrl: null, publishedAt: null };
        }
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4, and the honest limits of it here.
        //
        // TikTok's posting API creates nothing before `init`, so a timeout on `init`
        // leaves no `publish_id` to ask about — there is no container to interrogate the
        // way Instagram and Threads allow. The Display API's video list is the only way to
        // look, and it needs a scope from a different product that the Content Posting
        // grant does not include.
        const granted = input.credentials.grantedScopes;
        if (!hasScopes(granted, [SCOPE_VIDEO_LIST])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires the ${SCOPE_VIDEO_LIST} permission from TikTok's Display API, which this connection did not grant.`,
          };
        }

        const wanted = input.content.text.trim();
        if (wanted === '') {
          return {
            conclusion: 'indeterminate',
            reason: 'The post has no caption, so it cannot be identified among recent videos.',
          };
        }

        const data = await call<{
          videos?: { id?: string; title?: string; create_time?: number; share_url?: string }[];
          has_more?: boolean;
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'POST',
          path: '/video/list/?fields=id,title,create_time,share_url',
          body: { max_count: 20 },
        });

        const attemptedAfter = Date.parse(input.attemptedAfter);
        const videos = data.videos ?? [];

        for (const video of videos) {
          // `create_time` is Unix seconds.
          const createdAt = video.create_time !== undefined ? video.create_time * 1000 : undefined;
          if (createdAt !== undefined && createdAt < attemptedAfter - 60_000) continue;
          if ((video.title ?? '').trim() === wanted && video.id) {
            return {
              conclusion: 'found',
              externalPostId: video.id,
              ...(video.share_url ? { externalUrl: video.share_url } : {}),
              ...(createdAt !== undefined ? { publishedAt: new Date(createdAt).toISOString() } : {}),
            };
          }
        }

        // A post still transcoding has not appeared in the list yet, so "not there" is not
        // "not created". Rule 14 — this cannot license a retry.
        return {
          conclusion: 'indeterminate',
          reason:
            'No matching video is listed, but TikTok publishes asynchronously and a post still processing would not appear yet.',
        };
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `TikTok timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `TikTok was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof TikTokError) {
        switch (error.code) {
          case 'access_token_invalid':
          case 'NO_REFRESH_TOKEN':
          case 'MISSING_CODE_VERIFIER':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'scope_not_authorized':
          case 'scope_permission_missed':
            return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: error.status };
          case 'privacy_level_not_available':
            return { code: 'PRIVACY_SELECTION_REQUIRED', message: error.message, status: error.status };
          case 'spam_risk_too_many_pending_share':
          case 'spam_risk_user_banned_from_posting':
          case 'spam_risk':
            // TikTok is refusing further posts from this account for now. Backing off is
            // the only thing that helps; retrying immediately deepens the penalty.
            return { code: 'RATE_LIMITED', message: error.message, status: error.status };
          case 'reached_active_user_cap':
          case 'rate_limit_exceeded':
            return {
              code: 'RATE_LIMITED',
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
            };
          case 'url_ownership_unverified':
            // A configuration fault, not a content fault: the media host is not verified
            // in TikTok's portal. Retrying cannot fix it.
            return {
              code: 'VALIDATION_FAILED',
              message: `${error.message} The media host must be verified in TikTok's developer portal before PULL_FROM_URL works.`,
              status: error.status,
            };
          case 'file_format_check_failed':
          case 'picture_size_check_failed':
          case 'frame_rate_check_failed':
            return { code: 'MEDIA_UNSUPPORTED', message: error.message, status: error.status };
          case 'duration_check_failed':
          case 'video_pull_failed':
          case 'photo_pull_failed':
            return { code: 'MEDIA_PROCESSING_FAILED', message: error.message, status: error.status };
          case 'publish_cancelled':
            return { code: 'CONTENT_REJECTED', message: error.message, status: error.status };
          case 'invalid_param':
            return { code: 'VALIDATION_FAILED', message: error.message, status: error.status };
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
          return { code: 'AUTH_EXPIRED', message: 'TikTok rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'TikTok is rate limiting this account.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'TikTok returned a server error.', status };
        }
      }

      // Rule 14 — not auto-retried. A publish whose outcome is unknown must be reconciled.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized TikTok failure during ${context.operation}.`,
      };
    },
  };
}
