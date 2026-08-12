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
 * YouTube adapter (Data API v3).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.google.com/youtube/v3/docs/videos/insert
 *   https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *   https://developers.google.com/youtube/v3/docs/videos/list
 *   https://developers.google.com/youtube/v3/docs/videos/delete
 *   https://developers.google.com/youtube/v3/docs/channels/list
 *   https://developers.google.com/youtube/v3/docs/playlistItems/list
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * Four things about this API shape the file:
 *
 *   An unverified API project uploads private videos, silently. Google restricts every
 *   upload from an unaudited project created after 28 July 2020 to private viewing,
 *   without failing the request. The video exists, the API reports success, and nobody can
 *   watch it. Plan §63 puts this on the critical path, so it is surfaced as a capability
 *   restriction and enforced in validation rather than discovered later.
 *
 *   Quota is the binding constraint, not rate. `videos.insert` costs 1,600 units against a
 *   default daily allowance of 10,000 — six uploads a day before a quota increase. That
 *   makes `quotaExceeded` a normal operating condition to classify properly, not an edge
 *   case, and it is why reconciliation reads the uploads playlist (1 unit) rather than
 *   calling search (100 units).
 *
 *   Upload is resumable and two-phased. The metadata POST returns a session URI in a
 *   `Location` header; the bytes go to that URI. Reading the body of the first response
 *   for a video id finds nothing.
 *
 *   Google issues a refresh token once. Without `access_type=offline` and
 *   `prompt=consent`, a re-authorization returns an access token and no refresh token, and
 *   the connection dies an hour later with no way to recover it.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

const YOUTUBE_API_VERSION = 'v3';

/** Documented ceilings for the video resource. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
/** The combined length of `snippet.tags` is capped at 500 characters. */
const MAX_TAGS_LENGTH = 500;

/** 256 GB, the documented maximum upload size. */
const MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024;

/**
 * Longest video an unverified YouTube account may upload. Verified accounts may go to 12
 * hours, but account verification is not something this adapter can observe, so the safe
 * figure is the one that always holds (Rule 14).
 */
const MAX_VIDEO_SECONDS = 15 * 60;

const SUPPORTED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/mpeg',
  'video/3gpp',
] as const;

const PRIVACY_STATUSES = ['public', 'unlisted', 'private'] as const;

/** Upload alone. Deliberately the narrowest scope that can publish. */
const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
/** Full read/write, needed to list channels, delete, and read the uploads playlist. */
const SCOPE_MANAGE = 'https://www.googleapis.com/auth/youtube';
const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';

const DEFAULT_SCOPES = [SCOPE_UPLOAD, SCOPE_MANAGE];

/**
 * Marks the Google Cloud project as having passed YouTube's API audit.
 *
 * Set on the `provider_apps` row once the audit is granted (plan §23, §63). Absent means
 * unverified, which is the safe assumption: an unverified project's uploads are forced
 * private whatever this adapter requests.
 */
const AUDITED_KEY = 'audited';

/** Default category. 22 is "People & Blogs", the safest general-purpose choice. */
const DEFAULT_CATEGORY_ID = '22';

export class YouTubeError extends Error {
  readonly status: number;
  /** Google's `error.errors[].reason`, e.g. `quotaExceeded`, `uploadLimitExceeded`. */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'YouTubeError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string; domain?: string }[];
  };
}

function toYouTubeError(status: number, body: unknown, headers: Headers, fallback: string): YouTubeError {
  const parsed = (body ?? {}) as GoogleErrorBody;
  const first = parsed.error?.errors?.[0];

  return new YouTubeError(
    status,
    // `reason` is the stable discriminator; `status` is the coarse gRPC-style name.
    first?.reason ?? parsed.error?.status,
    parsed.error?.message ?? first?.message ?? fallback,
    parseRetryAfter(headers),
  );
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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
    throw toYouTubeError(
      response.status,
      response.json,
      response.headers,
      `YouTube returned ${response.status}.`,
    );
  }

  return (response.json ?? {}) as T;
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new YouTubeError(401, 'authError', 'This connection has no YouTube access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    throw new YouTubeError(
      500,
      'MISSING_APP',
      'No YouTube application is configured. Add its client id and secret before connecting.',
    );
  }
  return app;
}

/** True only when the operator has recorded that Google audited the project. */
function isAudited(app: ProviderAppCredentials | null): boolean {
  return app?.metadata[AUDITED_KEY] === true;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'youtube',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      video: true,
      // `status.publishAt` schedules a private video to go public at a chosen instant —
      // genuine provider-side scheduling, not the engine holding the post.
      native_scheduling: true,
    },
    actions: {
      delete_post: true,
      // `videos.update` can change title, description and privacy after publishing.
      edit_post: true,
      comments_read: true,
      comments_reply: true,
      analytics_read: false,
    },
    constraints: {
      // The description is what a caller writes as post text; the title is derived or
      // supplied through provider options.
      max_text_length: MAX_DESCRIPTION,
      max_media_count: 1,
      max_video_bytes: MAX_VIDEO_BYTES,
      max_video_duration_seconds: MAX_VIDEO_SECONDS,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      allowed_privacy_levels: PRIVACY_STATUSES,
      supports_alt_text: false,
    },
  });
}

interface YouTubeChannel {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

async function fetchChannels(
  context: ProviderCallContext,
  accessToken: string,
): Promise<YouTubeChannel[]> {
  const data = await call<{ items?: YouTubeChannel[] }>(context, {
    accessToken,
    method: 'GET',
    path: '/channels?part=snippet,contentDetails&mine=true&maxResults=50',
  });
  return data.items ?? [];
}

function channelIdentity(channel: YouTubeChannel, grantedScopes: readonly string[]): ConnectionIdentity {
  return {
    externalAccountId: channel.id ?? '',
    displayName: channel.snippet?.title ?? 'YouTube channel',
    handle: channel.snippet?.customUrl ?? null,
    avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
    accountType: 'channel',
    grantedScopes,
  };
}

/** Titles are capped at 100 characters and `<`/`>` are rejected outright. */
function deriveTitle(text: string, providerOptions: Readonly<Record<string, unknown>>): string {
  const explicit = providerOptions.title;
  const raw =
    typeof explicit === 'string' && explicit.trim() !== ''
      ? explicit
      : // First non-empty line of the description, which is what a caller means by "the
        // post text" when they have not named a title.
        (text.split('\n').find((line) => line.trim() !== '') ?? 'Untitled');

  return [...raw.replace(/[<>]/g, '')].slice(0, MAX_TITLE).join('');
}

export function createYouTubeAdapter(): SocialProviderAdapter {
  return {
    provider: 'youtube',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: YOUTUBE_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      const canUpload = hasScopes(granted, [SCOPE_UPLOAD]) || hasScopes(granted, [SCOPE_MANAGE]);
      if (!canUpload) {
        restrictions.push(scopeRestriction('publishing.video', [SCOPE_UPLOAD, SCOPE_MANAGE]));
        restrictions.push(scopeRestriction('publishing.native_scheduling', [SCOPE_UPLOAD, SCOPE_MANAGE]));
      }

      // Deleting and editing need full management; the upload-only scope cannot do either.
      if (!hasScopes(granted, [SCOPE_MANAGE])) {
        restrictions.push(scopeRestriction('actions.delete_post', [SCOPE_MANAGE]));
        restrictions.push(scopeRestriction('actions.edit_post', [SCOPE_MANAGE]));
        restrictions.push(scopeRestriction('actions.comments_reply', [SCOPE_MANAGE]));
        if (!hasScopes(granted, [SCOPE_READONLY])) {
          restrictions.push(scopeRestriction('actions.comments_read', [SCOPE_MANAGE, SCOPE_READONLY]));
        }
      }

      const audited = isAudited(context.app);
      if (!audited) {
        // Plan §63. Google does not fail the upload — it publishes the video privately and
        // reports success, which is the worst possible way to find out.
        restrictions.push(
          approvalRestriction(
            'constraints.allowed_privacy_levels',
            'This Google Cloud project has not passed the YouTube API audit, so uploads are forced to private viewing whatever privacy status is requested.',
          ),
        );
      }

      const effective = restrictCapabilities(generic, restrictions);
      if (audited) return effective;

      return {
        ...effective,
        constraints: { ...effective.constraints, allowed_privacy_levels: ['private'] },
      };
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? [...input.requestedScopes] : DEFAULT_SCOPES;

        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', app.clientId);
        url.searchParams.set('redirect_uri', app.redirectUri);
        url.searchParams.set('scope', scopes.join(' '));
        url.searchParams.set('state', input.state);
        // Both are required to receive a refresh token, and both are easy to omit.
        // `access_type=offline` asks for one; `prompt=consent` is what makes Google issue
        // it again on a re-authorization instead of returning only an access token that
        // expires in an hour with nothing to renew it.
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('include_granted_scopes', 'true');

        return { authorizationUrl: url.toString(), state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new YouTubeError(
            400,
            input.query.error,
            input.query.error === 'access_denied'
              ? 'YouTube authorization was declined.'
              : (input.query.error_description ?? 'YouTube authorization failed.'),
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new YouTubeError(400, 'MISSING_CODE', 'Google did not return an authorization code.');
        }

        const response = await providerFetch(input.context, 'https://oauth2.googleapis.com/token', {
          operation: 'oauth2.token',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: app.clientId,
            client_secret: app.clientSecret,
            redirect_uri: app.redirectUri,
          }).toString(),
        });

        if (!response.ok) {
          const body = (response.json ?? {}) as { error?: string; error_description?: string };
          throw new YouTubeError(
            response.status,
            body.error ?? 'TOKEN_EXCHANGE_FAILED',
            body.error_description ?? 'Could not exchange the authorization code.',
          );
        }

        const token = response.json as {
          access_token: string;
          expires_in?: number;
          refresh_token?: string;
          scope?: string;
        };

        const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [];
        const channels = await fetchChannels(input.context, token.access_token);
        const channel = channels[0];

        if (!channel?.id) {
          // A Google account with no YouTube channel authorizes fine and can do nothing.
          // Saying so now beats an upload failing with a confusing permission error.
          throw new YouTubeError(
            403,
            'channelNotFound',
            'This Google account has no YouTube channel. Create one, then connect again.',
          );
        }

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: channel.id,
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
            grantedScopes,
            metadata: {},
          },
          identity: channelIdentity(channel, grantedScopes),
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);

        if (!input.credentials.refreshToken) {
          // Google issues one refresh token per grant. Without it the only recovery is a
          // fresh consent, and access tokens last an hour.
          throw new YouTubeError(
            401,
            'NO_REFRESH_TOKEN',
            'This YouTube connection has no refresh token and must be reconnected.',
          );
        }

        const response = await providerFetch(input.context, 'https://oauth2.googleapis.com/token', {
          operation: 'oauth2.refresh',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: input.credentials.refreshToken,
            client_id: app.clientId,
            client_secret: app.clientSecret,
          }).toString(),
        });

        if (!response.ok) {
          const body = (response.json ?? {}) as { error?: string; error_description?: string };
          throw new YouTubeError(
            response.status,
            body.error ?? 'REFRESH_FAILED',
            body.error_description ?? 'Could not refresh the YouTube token.',
          );
        }

        const token = response.json as { access_token: string; expires_in?: number };

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // Google does not return a refresh token on refresh. Keeping the existing one
            // is correct here — unlike X, where it would be a bug.
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
          },
          rotated: true,
        };
      },

      async revoke(input) {
        const token = input.credentials.refreshToken ?? input.credentials.accessToken;
        if (!token) return;

        const response = await providerFetch(input.context, 'https://oauth2.googleapis.com/revoke', {
          operation: 'oauth2.revoke',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
        });

        // A token Google has already forgotten is the state we wanted.
        if (!response.ok && response.status !== 400) {
          throw new YouTubeError(response.status, 'REVOKE_FAILED', 'Could not revoke the YouTube token.');
        }
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const channels = await fetchChannels(input.context, accessTokenOf(input.credentials));
        const channel =
          channels.find((item) => item.id === input.credentials.externalAccountId) ?? channels[0];

        if (!channel?.id) {
          throw new YouTubeError(403, 'channelNotFound', 'This connection no longer has a YouTube channel.');
        }
        return channelIdentity(channel, input.credentials.grantedScopes);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const channels = await fetchChannels(input.context, accessTokenOf(input.credentials));

        return channels
          .filter((channel): channel is YouTubeChannel & { id: string } => Boolean(channel.id))
          .map((channel) => ({
            externalId: channel.id,
            displayName: channel.snippet?.title ?? 'YouTube channel',
            handle: channel.snippet?.customUrl ?? null,
            avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
            kind: 'channel',
            // The uploads playlist is how reconciliation looks for a video at a cost of
            // one quota unit instead of search's hundred. Worth carrying.
            metadata: { uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads ?? null },
          }));
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const videos = content.media.filter((item) => item.kind === 'video');

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_DESCRIPTION, {
              code: 'TEXT_TOO_LONG',
              truncatable: true,
            }),
          ),
        );

        if (videos.length === 0) {
          // YouTube publishes videos. There is no text post, and no image post.
          results.push(
            f.error('MEDIA_REQUIRED', 'A YouTube post needs a video.', {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }
        if (content.media.length > videos.length) {
          results.push(
            f.error('MEDIA_TYPE_UNSUPPORTED', 'YouTube accepts a video, not images.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }
        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'A YouTube upload carries exactly one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }

        videos.forEach((video, index) => {
          results.push(
            ...f.collect(
              f.checkMediaType(video.mimeType, SUPPORTED_VIDEO_TYPES, index),
              f.checkMediaSize(video.bytes, MAX_VIDEO_BYTES, index),
              f.checkVideoDuration(video.durationSeconds, { min: null, max: MAX_VIDEO_SECONDS }, index),
            ),
          );
        });

        const title = deriveTitle(content.text, content.providerOptions);
        if (title.trim() === '') {
          results.push(
            f.error('TITLE_REQUIRED', 'A YouTube video needs a title.', {
              field: 'providerOptions.title',
              agentAction: 'add_a_title',
            }),
          );
        }
        // `<` and `>` are rejected in titles and descriptions. The title is stripped
        // automatically; flagging it keeps the caller from wondering what changed.
        if (typeof content.providerOptions.title === 'string' && /[<>]/.test(content.providerOptions.title)) {
          results.push(
            f.warning('TITLE_CHARACTERS_REMOVED', 'YouTube rejects < and > in a title; they will be removed.', {
              field: 'providerOptions.title',
              agentAction: 'remove_angle_brackets',
            }),
          );
        }
        if (/[<>]/.test(content.text)) {
          results.push(
            f.error('DESCRIPTION_CHARACTERS_INVALID', 'YouTube rejects < and > in a description.', {
              field: 'content.text',
              agentAction: 'remove_angle_brackets',
            }),
          );
        }

        const tags = content.providerOptions.tags;
        if (Array.isArray(tags)) {
          const total = tags.join('').length;
          if (total > MAX_TAGS_LENGTH) {
            results.push(
              f.error('TAGS_TOO_LONG', `Tags total ${total} characters; YouTube allows ${MAX_TAGS_LENGTH}.`, {
                field: 'providerOptions.tags',
                agentAction: 'remove_tags',
              }),
            );
          }
        }

        const privacy = content.providerOptions.privacyStatus;
        if (privacy !== undefined) {
          if (typeof privacy !== 'string' || !(PRIVACY_STATUSES as readonly string[]).includes(privacy)) {
            results.push(
              f.error('PRIVACY_LEVEL_INVALID', `"${String(privacy)}" is not a YouTube privacy status.`, {
                field: 'providerOptions.privacyStatus',
                agentAction: 'choose_a_privacy_level',
              }),
            );
          } else if (!isAudited(input.app) && privacy !== 'private') {
            // Plan §63. Google would accept this and publish it privately anyway, so the
            // caller would believe a public video exists that nobody can watch.
            results.push(
              f.error(
                'PRIVACY_LEVEL_NOT_PERMITTED',
                'This Google Cloud project has not passed the YouTube API audit, so uploads are forced to private viewing.',
                {
                  field: 'providerOptions.privacyStatus',
                  agentAction: 'await_platform_approval',
                },
              ),
            );
          }
        }

        // `selfDeclaredMadeForKids` is a legal declaration under COPPA, and YouTube
        // requires it on every upload. Guessing it is not an option (Rule 14).
        if (typeof content.compliance.madeForKids !== 'boolean') {
          results.push(
            f.error(
              'AUDIENCE_DECLARATION_REQUIRED',
              'YouTube requires every upload to declare whether it is made for kids.',
              {
                field: 'compliance.madeForKids',
                agentAction: 'declare_child_directed_status',
              },
            ),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = accessTokenOf(input.credentials);
        const video = input.content.media.find((item) => item.kind === 'video');
        if (!video) {
          throw new YouTubeError(400, 'MEDIA_REQUIRED', 'A YouTube post needs a video.');
        }

        const audited = isAudited(input.app);
        const requested = input.content.providerOptions.privacyStatus;
        // An unverified project's upload lands private regardless. Asking for private
        // explicitly keeps the request and the outcome in agreement.
        const privacyStatus = audited && typeof requested === 'string' ? requested : 'private';

        const status: Record<string, unknown> = {
          privacyStatus,
          selfDeclaredMadeForKids: input.content.compliance.madeForKids === true,
        };

        const publishAt = input.content.providerOptions.publishAt;
        if (typeof publishAt === 'string' && privacyStatus === 'private') {
          // Provider-side scheduling. YouTube only honours `publishAt` on a private video —
          // setting it on a public one is silently ignored.
          status.publishAt = publishAt;
        }

        const snippet: Record<string, unknown> = {
          title: deriveTitle(input.content.text, input.content.providerOptions),
          description: input.content.text,
          categoryId:
            typeof input.content.providerOptions.categoryId === 'string'
              ? input.content.providerOptions.categoryId
              : DEFAULT_CATEGORY_ID,
        };

        const tags = input.content.providerOptions.tags;
        if (Array.isArray(tags)) snippet.tags = tags;

        // Phase one: open the resumable session. This creates no video and can be retried
        // freely, which is exactly why it belongs in `prepare`.
        const initiation = await providerFetch(
          input.context,
          `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
          {
            operation: 'videos.insert.initiate',
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': String(video.bytes),
              'X-Upload-Content-Type': video.mimeType,
            },
            body: JSON.stringify({ snippet, status }),
          },
        );

        if (!initiation.ok) {
          throw toYouTubeError(
            initiation.status,
            initiation.json,
            initiation.headers,
            'YouTube would not start the upload session.',
          );
        }

        // The session URI is in a HEADER. The body carries nothing useful, and reading it
        // for a video id finds nothing.
        const sessionUri = initiation.headers.get('location');
        if (!sessionUri) {
          throw new YouTubeError(502, 'MISSING_SESSION_URI', 'YouTube did not return an upload session URI.');
        }

        return { state: { sessionUri, mediaId: video.mediaId }, providerMediaIds: [sessionUri] };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const sessionUri = input.prepared.state.sessionUri as string | undefined;
        const video = input.content.media.find((item) => item.kind === 'video');

        if (!sessionUri || !video) {
          throw new YouTubeError(500, 'MISSING_SESSION_URI', 'The YouTube upload session was not prepared.');
        }

        const source = await fetch(video.downloadUrl, { signal: input.context.signal });
        if (!source.ok || !source.body) {
          throw new YouTubeError(source.status, 'MEDIA_FETCH_FAILED', 'Could not read the media file.');
        }

        // The bytes are streamed straight through rather than buffered: a video can be far
        // larger than a Worker's memory, and holding it would fail at a size the API
        // happily accepts.
        const upload = await providerFetch(input.context, sessionUri, {
          operation: 'videos.insert.upload',
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': video.mimeType,
            'content-length': String(video.bytes),
          },
          body: source.body,
          timeoutMs: 600_000,
        });

        if (!upload.ok) {
          throw toYouTubeError(
            upload.status,
            upload.json,
            upload.headers,
            'YouTube rejected the video upload.',
          );
        }

        const created = (upload.json ?? {}) as { id?: string; status?: { uploadStatus?: string } };
        if (!created.id) {
          throw new YouTubeError(502, 'MISSING_VIDEO_ID', 'YouTube did not return a video id.');
        }

        // The bytes are in, but YouTube still has to process them and can still reject the
        // video. `processed` is the only state that means it is really live.
        const done = created.status?.uploadStatus === 'processed';

        return {
          outcome: done ? 'published' : 'processing',
          externalPostId: created.id,
          externalUrl: `https://www.youtube.com/watch?v=${created.id}`,
          publishedAt: done ? new Date().toISOString() : null,
          statusHandle: created.id,
          metadata: {},
        };
      },

      async status(input) {
        const data = await call<{
          items?: {
            id?: string;
            status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string };
          }[];
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: `/videos?part=status&id=${encodeURIComponent(input.statusHandle)}`,
        });

        const item = data.items?.[0];
        if (!item) {
          // The video is gone from YouTube's index. Either it was deleted or it never
          // completed; either way there is nothing to wait for.
          return {
            outcome: 'failed',
            externalPostId: null,
            externalUrl: null,
            publishedAt: null,
            failureReason: 'YouTube no longer lists this video.',
          };
        }

        switch (item.status?.uploadStatus) {
          case 'processed':
            return {
              outcome: 'published',
              externalPostId: input.statusHandle,
              externalUrl: `https://www.youtube.com/watch?v=${input.statusHandle}`,
              publishedAt: new Date().toISOString(),
            };
          case 'failed':
          case 'rejected':
          case 'deleted':
            return {
              outcome: 'failed',
              externalPostId: null,
              externalUrl: null,
              publishedAt: null,
              failureReason:
                item.status.rejectionReason ??
                item.status.failureReason ??
                'YouTube rejected the video during processing.',
            };
          default:
            // `uploaded` — received, not yet processed.
            return { outcome: 'processing', externalPostId: null, externalUrl: null, publishedAt: null };
        }
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. The uploads playlist costs one quota unit; search costs a
        // hundred, which matters when the whole daily allowance is ten thousand and a
        // single upload spends sixteen hundred of it.
        const granted = input.credentials.grantedScopes;
        if (!hasScopes(granted, [SCOPE_MANAGE]) && !hasScopes(granted, [SCOPE_READONLY])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires ${SCOPE_MANAGE} or ${SCOPE_READONLY}; the upload-only scope cannot read the channel.`,
          };
        }

        const accessToken = accessTokenOf(input.credentials);
        const channels = await fetchChannels(input.context, accessToken);
        const channel =
          channels.find((item) => item.id === input.target.destinationExternalId) ?? channels[0];
        const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;

        if (!uploads) {
          return {
            conclusion: 'indeterminate',
            reason: 'YouTube did not report an uploads playlist for this channel.',
          };
        }

        const data = await call<{
          items?: {
            snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
          }[];
        }>(input.context, {
          accessToken,
          method: 'GET',
          path: `/playlistItems?part=snippet&maxResults=25&playlistId=${encodeURIComponent(uploads)}`,
        });

        const wanted = deriveTitle(input.content.text, input.content.providerOptions).trim();
        const attemptedAfter = Date.parse(input.attemptedAfter);

        for (const item of data.items ?? []) {
          const publishedAt = item.snippet?.publishedAt
            ? Date.parse(item.snippet.publishedAt)
            : undefined;
          if (publishedAt !== undefined && publishedAt < attemptedAfter - 60_000) continue;

          if ((item.snippet?.title ?? '').trim() === wanted && item.snippet?.resourceId?.videoId) {
            const videoId = item.snippet.resourceId.videoId;
            return {
              conclusion: 'found',
              externalPostId: videoId,
              externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
              ...(publishedAt !== undefined
                ? { publishedAt: new Date(publishedAt).toISOString() }
                : {}),
            };
          }
        }

        // A video still processing is not in the uploads playlist yet, so absence here
        // does not prove absence on YouTube. Rule 14 — this must not license a retry that
        // would upload the same video twice at 1,600 quota units a go.
        return {
          conclusion: 'indeterminate',
          reason:
            'No matching video is in the uploads playlist, but YouTube processes uploads asynchronously and one still processing would not appear yet.',
        };
      },

      async delete(input) {
        try {
          await call(input.context, {
            accessToken: accessTokenOf(input.credentials),
            method: 'DELETE',
            path: `/videos?id=${encodeURIComponent(input.externalPostId)}`,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          if (error instanceof YouTubeError && (error.status === 404 || error.code === 'videoNotFound')) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `YouTube timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `YouTube was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof YouTubeError) {
        switch (error.code) {
          case 'quotaExceeded':
          case 'dailyLimitExceeded':
            // The daily allowance is spent. Retrying before it resets can only fail, and
            // `videos.insert` costs 1,600 units of 10,000 — this is a routine condition.
            return { code: 'DAILY_QUOTA_EXCEEDED', message: error.message, status: error.status };
          case 'uploadLimitExceeded':
            return { code: 'DAILY_QUOTA_EXCEEDED', message: error.message, status: error.status };
          case 'rateLimitExceeded':
          case 'userRateLimitExceeded':
            return {
              code: 'RATE_LIMITED',
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
            };
          case 'authError':
          case 'NO_REFRESH_TOKEN':
          case 'invalid_grant':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'insufficientPermissions':
          case 'forbidden':
            return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: error.status };
          case 'channelNotFound':
          case 'videoNotFound':
            return { code: 'DESTINATION_NOT_FOUND', message: error.message, status: error.status };
          case 'invalidTitle':
          case 'invalidDescription':
          case 'invalidTags':
          case 'invalidCategoryId':
          case 'invalidVideoMetadata':
            return { code: 'VALIDATION_FAILED', message: error.message, status: error.status };
          case 'invalidFilename':
          case 'mediaBodyRequired':
          case 'invalidVideoFormat':
            return { code: 'MEDIA_UNSUPPORTED', message: error.message, status: error.status };
          case 'videoTooLong':
          case 'uploadLimitExceededForVideoLength':
            return { code: 'MEDIA_UNSUPPORTED', message: error.message, status: error.status };
          case 'failedPrecondition':
          case 'MEDIA_FETCH_FAILED':
            return { code: 'MEDIA_PROCESSING_FAILED', message: error.message, status: error.status };
          case 'forbiddenLicenseSetting':
          case 'invalidRecordingDetails':
            return { code: 'CONTENT_REJECTED', message: error.message, status: error.status };
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
          return { code: 'AUTH_EXPIRED', message: 'YouTube rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'YouTube is rate limiting this project.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'YouTube returned a server error.', status };
        }
      }

      // Rule 14 — not auto-retried. Re-uploading a video that may already exist costs
      // 1,600 quota units and produces a duplicate on the channel.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized YouTube failure during ${context.operation}.`,
      };
    },
  };
}
