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
 * Pinterest adapter (API v5).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.pinterest.com/docs/api/v5/pins-create/
 *   https://developers.pinterest.com/docs/api/v5/media-create/
 *   https://developers.pinterest.com/docs/api/v5/boards-list/
 *   https://developers.pinterest.com/docs/api/v5/boards-list-pins/
 *   https://developers.pinterest.com/docs/api/v5/pins-delete/
 *   https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
 *   https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
 *
 * Four things about this API shape the file:
 *
 *   A board is the destination, not the account. One connection exposes every board the
 *   account owns, and a Pin without a `board_id` has nowhere to go. This is the clearest
 *   case in the product for why connection and destination are separate tables (plan §8.5).
 *
 *   Images are pulled from a URL; video is pushed through a registration dance. An image
 *   Pin hands Pinterest a URL and it fetches the bytes during creation. A video has to be
 *   registered first, uploaded to the S3 form Pinterest returns, and polled until it
 *   reports `succeeded` — and the upload leg carries no Authorization header, because it
 *   goes to AWS rather than to Pinterest.
 *
 *   The token endpoint wants HTTP Basic. Credentials go in the header, not the body.
 *
 *   Pinterest deduplicates nothing. There is no idempotency key on Pin creation, so
 *   reconciliation through the board's own Pin list (ADR-006 Layer 4) is the only defence
 *   against a retry creating a second Pin.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://api.pinterest.com/v5';

const PINTEREST_API_VERSION = 'v5';

/**
 * Field ceilings.
 *
 * Pinterest does not publish these in the v5 reference; they are the limits its own
 * composer enforces and the figures this product validates against. Treated as validation
 * ceilings rather than certainties — if Pinterest rejects something shorter, the
 * normalized error still explains it (the same call the LinkedIn adapter makes about
 * commentary length).
 */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 800;
const MAX_ALT_TEXT = 500;

/** A carousel Pin holds between two and five images. */
const MIN_CAROUSEL = 2;
const MAX_CAROUSEL = 5;

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_VIDEO_SECONDS = 4;
const MAX_VIDEO_SECONDS = 15 * 60;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v'] as const;

const SCOPE_PINS_WRITE = 'pins:write';
const SCOPE_PINS_READ = 'pins:read';
const SCOPE_BOARDS_READ = 'boards:read';
const SCOPE_USER_READ = 'user_accounts:read';

const DEFAULT_SCOPES = [SCOPE_USER_READ, SCOPE_BOARDS_READ, SCOPE_PINS_READ, SCOPE_PINS_WRITE];

/** How long `prepare` will wait for Pinterest to finish transcoding a registered video. */
const MAX_MEDIA_PROCESSING_MS = 300_000;

export class PinterestError extends Error {
  readonly status: number;
  /** Pinterest's numeric `code`, carried as a string so it reads uniformly. */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'PinterestError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface PinterestErrorBody {
  code?: number;
  message?: string;
  message_detail?: string;
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
    const body = (response.json ?? {}) as PinterestErrorBody;
    throw new PinterestError(
      response.status,
      body.code !== undefined ? String(body.code) : undefined,
      // `message_detail` is where Pinterest says which field is wrong; `message` alone is
      // often just "Invalid parameters."
      body.message_detail ?? body.message ?? `Pinterest returned ${response.status}.`,
      parseRetryAfter(response.headers),
    );
  }

  return (response.json ?? {}) as T;
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new PinterestError(401, 'EMPTY_ACCESS_TOKEN', 'This connection has no Pinterest access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    throw new PinterestError(
      500,
      'MISSING_APP',
      'No Pinterest application is configured. Add its app id and secret before connecting.',
    );
  }
  return app;
}

/**
 * Pinterest authenticates the token endpoint with HTTP Basic. Putting the secret in the
 * form body returns an authentication error that says nothing about where it belongs.
 */
function basicAuth(app: ProviderAppCredentials): string {
  return `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`;
}

/** Title and description are separate fields; the caller writes one block of text. */
function deriveTitle(text: string, providerOptions: Readonly<Record<string, unknown>>): string {
  const explicit = providerOptions.title;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return [...explicit].slice(0, MAX_TITLE).join('');
  }
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return [...firstLine].slice(0, MAX_TITLE).join('');
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'pinterest',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      image: true,
      video: true,
      carousel: true,
      // A Pin's `link` is its destination URL — the whole point of the format, not an
      // unfurled preview bolted onto text.
      link_preview: true,
    },
    actions: {
      delete_post: true,
      edit_post: true,
      analytics_read: true,
    },
    constraints: {
      max_text_length: MAX_DESCRIPTION,
      max_media_count: MAX_CAROUSEL,
      max_image_bytes: MAX_IMAGE_BYTES,
      max_video_bytes: MAX_VIDEO_BYTES,
      max_video_duration_seconds: MAX_VIDEO_SECONDS,
      min_video_duration_seconds: MIN_VIDEO_SECONDS,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      supports_alt_text: true,
    },
  });
}

interface PinterestBoard {
  id?: string;
  name?: string;
  description?: string;
  privacy?: string;
  media?: { image_cover_url?: string };
}

interface PinterestAccount {
  username?: string;
  account_type?: string;
  profile_image?: string;
  website_url?: string;
  id?: string;
}

async function fetchAccount(
  context: ProviderCallContext,
  accessToken: string,
): Promise<PinterestAccount> {
  return call<PinterestAccount>(context, {
    accessToken,
    method: 'GET',
    path: '/user_account',
  });
}

function identityOf(
  account: PinterestAccount,
  grantedScopes: readonly string[],
): ConnectionIdentity {
  // `user_account` does not always return an id; the username is the stable handle and
  // the only identifier Pinterest guarantees here.
  const id = account.id ?? account.username ?? '';
  return {
    externalAccountId: id,
    displayName: account.username ?? 'Pinterest account',
    handle: account.username ? `@${account.username}` : null,
    avatarUrl: account.profile_image ?? null,
    accountType: account.account_type ?? null,
    grantedScopes,
  };
}

/**
 * Register a video, push the bytes to the form Pinterest returns, and wait for it to
 * finish processing.
 *
 * The upload leg goes to AWS, not to Pinterest, so it carries no bearer token — sending
 * one gets the request rejected by S3 for reasons that read like a Pinterest permission
 * problem.
 */
async function uploadVideo(
  context: ProviderCallContext,
  accessToken: string,
  media: ResolvedMedia,
): Promise<string> {
  const registered = await call<{
    media_id?: string;
    media_type?: string;
    upload_url?: string;
    upload_parameters?: Record<string, string>;
  }>(context, {
    accessToken,
    method: 'POST',
    path: '/media',
    body: { media_type: 'video' },
  });

  const mediaId = registered.media_id;
  const uploadUrl = registered.upload_url;
  if (!mediaId || !uploadUrl) {
    throw new PinterestError(502, 'MISSING_MEDIA_ID', 'Pinterest did not return a media upload target.');
  }

  const source = await fetch(media.downloadUrl, { signal: context.signal });
  if (!source.ok) {
    throw new PinterestError(source.status, 'MEDIA_FETCH_FAILED', 'Could not read the media file.');
  }

  const form = new FormData();
  // Every parameter Pinterest returned must be replayed, in the order given, before the
  // file field. S3's presigned POST policy rejects the form otherwise.
  for (const [key, value] of Object.entries(registered.upload_parameters ?? {})) {
    form.set(key, value);
  }
  form.set('file', new Blob([await source.arrayBuffer()], { type: media.mimeType }));

  const upload = await providerFetch(context, uploadUrl, {
    operation: 'media.upload',
    method: 'POST',
    body: form,
    timeoutMs: 300_000,
  });

  // The documented success is 204 No Content.
  if (!upload.ok) {
    throw new PinterestError(upload.status, 'UPLOAD_FAILED', 'Pinterest rejected the video upload.');
  }

  await awaitMediaProcessing(context, accessToken, mediaId);
  return mediaId;
}

async function awaitMediaProcessing(
  context: ProviderCallContext,
  accessToken: string,
  mediaId: string,
): Promise<void> {
  const deadline = Date.now() + MAX_MEDIA_PROCESSING_MS;

  for (;;) {
    const media = await call<{ status?: string }>(context, {
      accessToken,
      method: 'GET',
      path: `/media/${encodeURIComponent(mediaId)}`,
    });

    if (media.status === 'succeeded') return;
    if (media.status === 'failed') {
      throw new PinterestError(422, 'MEDIA_PROCESSING_FAILED', 'Pinterest could not process the video.');
    }
    if (Date.now() >= deadline) {
      throw new PinterestError(
        504,
        'MEDIA_PROCESSING_TIMEOUT',
        'Pinterest did not finish processing the video in time.',
      );
    }

    // Creating a Pin against a video that is still `processing` fails, so this waits.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      context.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ProviderTimeoutError('media.status', 5000));
        },
        { once: true },
      );
    });
  }
}

export function createPinterestAdapter(): SocialProviderAdapter {
  return {
    provider: 'pinterest',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: PINTEREST_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [SCOPE_PINS_WRITE])) {
        for (const capability of ['image', 'video', 'carousel', 'link_preview']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_PINS_WRITE]));
        }
        restrictions.push(scopeRestriction('actions.delete_post', [SCOPE_PINS_WRITE]));
        restrictions.push(scopeRestriction('actions.edit_post', [SCOPE_PINS_WRITE]));
      }

      if (!hasScopes(granted, [SCOPE_PINS_READ])) {
        restrictions.push(scopeRestriction('actions.analytics_read', [SCOPE_PINS_READ]));
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? [...input.requestedScopes] : DEFAULT_SCOPES;

        const url = new URL('https://www.pinterest.com/oauth/');
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', app.clientId);
        url.searchParams.set('redirect_uri', app.redirectUri);
        url.searchParams.set('scope', scopes.join(','));
        url.searchParams.set('state', input.state);

        return { authorizationUrl: url.toString(), state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new PinterestError(
            400,
            input.query.error,
            input.query.error_description ?? 'Pinterest authorization was declined.',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new PinterestError(400, 'MISSING_CODE', 'Pinterest did not return an authorization code.');
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth/token`, {
          operation: 'oauth.token',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basicAuth(app),
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: app.redirectUri,
          }).toString(),
        });

        if (!response.ok) {
          const body = (response.json ?? {}) as PinterestErrorBody;
          throw new PinterestError(
            response.status,
            'TOKEN_EXCHANGE_FAILED',
            body.message ?? 'Could not exchange the authorization code.',
          );
        }

        const token = response.json as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
          refresh_token_expires_in?: number;
          scope?: string;
        };

        const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [];
        const account = await fetchAccount(input.context, token.access_token);
        const identity = identityOf(account, grantedScopes);

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: identity.externalAccountId,
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
            grantedScopes,
            metadata: { username: account.username ?? null },
          },
          identity,
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);

        if (!input.credentials.refreshToken) {
          throw new PinterestError(
            401,
            'NO_REFRESH_TOKEN',
            'This Pinterest connection has no refresh token and must be reconnected.',
          );
        }

        const response = await providerFetch(input.context, `${API_BASE}/oauth/token`, {
          operation: 'oauth.refresh',
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basicAuth(app),
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: input.credentials.refreshToken,
          }).toString(),
        });

        if (!response.ok) {
          throw new PinterestError(
            response.status,
            'REFRESH_FAILED',
            'Could not refresh the Pinterest token.',
          );
        }

        const token = response.json as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // Pinterest returns a new refresh token only when continuous refresh is
            // enabled on the app; keeping the existing one otherwise is correct.
            refreshToken: token.refresh_token ?? input.credentials.refreshToken,
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
          },
          rotated: true,
        };
      },

      async revoke() {
        // Pinterest's v5 revoke endpoint is documented but rejects the tokens this flow
        // issues. Access is removed by the account holder from Pinterest's connected-apps
        // settings; the engine records the disconnect either way (Rule 14 — do not pretend
        // an operation succeeded).
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const account = await fetchAccount(input.context, accessTokenOf(input.credentials));
        return identityOf(account, input.credentials.grantedScopes);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        // Boards are the destinations. A Pin without a board has nowhere to go, which is
        // why this list is the connect flow's whole point on Pinterest.
        const data = await call<{ items?: PinterestBoard[] }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: '/boards?page_size=100',
        });

        return (data.items ?? [])
          .filter((board): board is PinterestBoard & { id: string } => Boolean(board.id))
          .map((board) => ({
            externalId: board.id,
            displayName: board.name ?? 'Pinterest board',
            handle: null,
            avatarUrl: board.media?.image_cover_url ?? null,
            kind: 'board',
            metadata: { privacy: board.privacy ?? null },
          }));
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const videos = content.media.filter((item) => item.kind === 'video');
        const images = content.media.filter((item) => item.kind === 'image');

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_DESCRIPTION, {
              code: 'TEXT_TOO_LONG',
              truncatable: true,
            }),
          ),
        );

        if (content.media.length === 0) {
          // Pinterest is a visual medium; there is no text-only Pin.
          results.push(
            f.error('MEDIA_REQUIRED', 'A Pin needs an image or a video.', {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }

        if (videos.length > 0 && images.length > 0) {
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'A Pin is images or a video, not both.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }
        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'A Pin carries at most one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }
        if (images.length > MAX_CAROUSEL) {
          results.push(...f.collect(f.checkMediaCount(images.length, MAX_CAROUSEL)));
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_VIDEO_TYPES, index),
                f.checkMediaSize(item.bytes, MAX_VIDEO_BYTES, index),
                f.checkVideoDuration(
                  item.durationSeconds,
                  { min: MIN_VIDEO_SECONDS, max: MAX_VIDEO_SECONDS },
                  index,
                ),
              ),
            );
          } else {
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index),
                f.checkMediaSize(item.bytes, MAX_IMAGE_BYTES, index),
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

        // A carousel needs at least two images. A single image in a carousel request is
        // rejected, and silently downgrading it would publish something else.
        if (content.providerOptions.carousel === true && images.length < MIN_CAROUSEL) {
          results.push(
            f.error('CAROUSEL_TOO_SHORT', `A carousel Pin needs at least ${MIN_CAROUSEL} images.`, {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }

        const title = deriveTitle(content.text, content.providerOptions);
        if (typeof content.providerOptions.title === 'string' &&
          [...content.providerOptions.title].length > MAX_TITLE) {
          results.push(
            f.warning('TITLE_TOO_LONG', `The title will be truncated to ${MAX_TITLE} characters.`, {
              field: 'providerOptions.title',
              agentAction: 'shorten_title',
            }),
          );
        }
        if (title.trim() === '' && content.text.trim() === '') {
          results.push(
            f.error('TEXT_REQUIRED', 'A Pin needs a title or a description.', {
              field: 'content',
              agentAction: 'add_text',
            }),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = accessTokenOf(input.credentials);
        const video = input.content.media.find((item) => item.kind === 'video');

        // Images need no preparation: Pinterest fetches them from the signed URL while
        // creating the Pin. Only video has a registration step to get through first.
        if (!video) return { state: {}, providerMediaIds: [] };

        const mediaId = await uploadVideo(input.context, accessToken, video);
        return { state: { mediaId }, providerMediaIds: [mediaId] };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const options = input.content.providerOptions;
        const images = input.content.media.filter((item) => item.kind === 'image');
        const mediaId = input.prepared.state.mediaId as string | undefined;

        let mediaSource: Record<string, unknown>;

        if (mediaId) {
          const cover = options.coverImageUrl;
          mediaSource = {
            source_type: 'video_id',
            media_id: mediaId,
            // Pinterest requires a cover for a video Pin. The first attached image is the
            // natural choice when the caller has not named one.
            cover_image_url: typeof cover === 'string' ? cover : (images[0]?.downloadUrl ?? ''),
          };
        } else if (images.length > 1) {
          mediaSource = {
            source_type: 'multiple_image_urls',
            items: images.map((image) => ({
              url: image.downloadUrl,
              ...(image.altText ? { title: image.altText.slice(0, MAX_TITLE) } : {}),
            })),
          };
        } else {
          const image = images[0];
          if (!image) {
            throw new PinterestError(400, 'MEDIA_REQUIRED', 'A Pin needs an image or a video.');
          }
          mediaSource = { source_type: 'image_url', url: image.downloadUrl };
        }

        const body: Record<string, unknown> = {
          board_id: input.target.destinationExternalId,
          title: deriveTitle(input.content.text, options),
          description: input.content.text,
          media_source: mediaSource,
        };

        if (input.content.linkUrl) body.link = input.content.linkUrl;
        if (typeof options.boardSectionId === 'string') body.board_section_id = options.boardSectionId;

        const altText = input.content.media[0]?.altText;
        if (altText) body.alt_text = altText.slice(0, MAX_ALT_TEXT);

        // Pinterest offers no idempotency key, so a retried create makes a second Pin.
        // `findPossibleDuplicate` below is what stands in for one.
        const created = await call<{ id?: string; created_at?: string }>(input.context, {
          accessToken,
          method: 'POST',
          path: '/pins',
          body,
        });

        if (!created.id) {
          throw new PinterestError(502, 'MISSING_PIN_ID', 'Pinterest did not return a Pin id.');
        }

        return {
          outcome: 'published',
          externalPostId: created.id,
          externalUrl: `https://www.pinterest.com/pin/${created.id}/`,
          publishedAt: created.created_at
            ? new Date(created.created_at).toISOString()
            : new Date().toISOString(),
          metadata: { boardId: input.target.destinationExternalId },
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. Listing the board's own Pins is cheap and exact — far better
        // than searching, because a Pin can only be on the board it was created on.
        const granted = input.credentials.grantedScopes;
        if (!hasScopes(granted, [SCOPE_PINS_READ]) && !hasScopes(granted, [SCOPE_BOARDS_READ])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires ${SCOPE_PINS_READ} or ${SCOPE_BOARDS_READ}, which this connection did not grant.`,
          };
        }

        const board = encodeURIComponent(input.target.destinationExternalId);
        const data = await call<{
          items?: { id?: string; title?: string; description?: string; created_at?: string }[];
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: `/boards/${board}/pins?page_size=50`,
        });

        const wantedTitle = deriveTitle(input.content.text, input.content.providerOptions).trim();
        const wantedDescription = input.content.text.trim();
        const attemptedAfter = Date.parse(input.attemptedAfter);
        const items = data.items ?? [];

        for (const pin of items) {
          const createdAt = pin.created_at ? Date.parse(pin.created_at) : undefined;
          if (createdAt !== undefined && createdAt < attemptedAfter - 60_000) continue;

          // Matching on the description as well as the title matters: a caller who leaves
          // the title empty gets one derived from the first line, and two Pins can share
          // that line while differing below it.
          if (
            (pin.description ?? '').trim() === wantedDescription &&
            (wantedTitle === '' || (pin.title ?? '').trim() === wantedTitle) &&
            pin.id
          ) {
            return {
              conclusion: 'found',
              externalPostId: pin.id,
              externalUrl: `https://www.pinterest.com/pin/${pin.id}/`,
              ...(createdAt !== undefined ? { publishedAt: new Date(createdAt).toISOString() } : {}),
            };
          }
        }

        if (items.length >= 50) {
          // A full page means an older match could sit just outside it (Rule 14).
          return {
            conclusion: 'indeterminate',
            reason: 'The board page was full, so a matching Pin cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          await call(input.context, {
            accessToken: accessTokenOf(input.credentials),
            method: 'DELETE',
            path: `/pins/${encodeURIComponent(input.externalPostId)}`,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          if (error instanceof PinterestError && error.status === 404) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `Pinterest timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Pinterest was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof PinterestError) {
        switch (error.code) {
          case 'EMPTY_ACCESS_TOKEN':
          case 'NO_REFRESH_TOKEN':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'MEDIA_PROCESSING_FAILED':
          case 'MEDIA_PROCESSING_TIMEOUT':
          case 'MEDIA_FETCH_FAILED':
          case 'UPLOAD_FAILED':
            // All happen in `prepare`, before the Pin exists, so there is nothing
            // ambiguous to reconcile.
            return { code: 'MEDIA_PROCESSING_FAILED', message: error.message, status: error.status };
          // Pinterest's numeric codes. 2 and 3 are the generic authentication and
          // permission failures; 29 is the documented rate limit.
          case '2':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case '3':
            return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: error.status };
          case '29':
            return {
              code: 'RATE_LIMITED',
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
            };
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
          return { code: 'AUTH_EXPIRED', message: 'Pinterest rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'Pinterest is rate limiting this account.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Pinterest returned a server error.', status };
        }
      }

      // Rule 14 — not auto-retried. Pinterest has no idempotency key, so a blind retry
      // makes a second Pin.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Pinterest failure during ${context.operation}.`,
      };
    },
  };
}
