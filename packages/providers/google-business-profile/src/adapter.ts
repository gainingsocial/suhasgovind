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
  type SocialProviderAdapter,
} from '@gs/provider-kit';

/**
 * Google Business Profile adapter (Local Posts).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
 *   https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
 *   https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/list
 *   https://developers.google.com/my-business/content/posts-data
 *   https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations
 *   https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * Four things about this API shape the file:
 *
 *   It is three APIs wearing one name. Accounts come from
 *   `mybusinessaccountmanagement`, locations from `mybusinessbusinessinformation`, and
 *   posts from the older `mybusiness` v4 host that Google has never migrated. One adapter,
 *   three base URLs, and a request sent to the wrong one 404s in a way that reads like a
 *   missing location.
 *
 *   A destination is a location, and its id is a path. Publishing needs
 *   `accounts/{account}/locations/{location}`, not a bare location id, so the whole
 *   resource path is what gets stored as the destination's external id.
 *
 *   Access is granted per project, by application. Unlike Meta's product review this is a
 *   quota request Google approves before the API responds at all — until then every call
 *   returns `PERMISSION_DENIED`. That is a platform-approval blocker, tracked in
 *   PLATFORM_APPROVALS.md, not something a scope change fixes.
 *
 *   `topicType` is required and decides the shape of everything else. A STANDARD post, an
 *   EVENT with a schedule and an OFFER with a coupon are three different bodies, and
 *   sending an event's fields on a standard post is rejected.
 */

export const ADAPTER_VERSION = '1.0.0';

/** Local Posts live on the v4 host Google never migrated. */
const POSTS_BASE = 'https://mybusiness.googleapis.com/v4';
const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFORMATION_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';

/** The posting surface is v4 even though the surrounding APIs are v1. */
const GBP_API_VERSION = 'v4';

/**
 * Summary ceiling.
 *
 * Google does not publish this in the Local Posts reference; 1500 is the limit its own
 * composer enforces and the figure this product validates against. Treated as a validation
 * ceiling rather than a certainty — the same call the LinkedIn adapter makes about
 * commentary length.
 */
const MAX_SUMMARY = 1500;

/** A local post carries one photo. */
const MAX_MEDIA_COUNT = 1;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 250;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

const TOPIC_TYPES = ['STANDARD', 'EVENT', 'OFFER', 'ALERT'] as const;
const ACTION_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'] as const;

const SCOPE_MANAGE = 'https://www.googleapis.com/auth/business.manage';

const DEFAULT_SCOPES = [SCOPE_MANAGE];

export class GoogleBusinessError extends Error {
  readonly status: number;
  /** Google's `error.status`, e.g. `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`. */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'GoogleBusinessError';
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
    details?: { reason?: string }[];
  };
}

function toGoogleError(status: number, body: unknown, headers: Headers, fallback: string) {
  const parsed = (body ?? {}) as GoogleErrorBody;
  return new GoogleBusinessError(
    status,
    parsed.error?.status ?? parsed.error?.details?.[0]?.reason,
    parsed.error?.message ?? fallback,
    parseRetryAfter(headers),
  );
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    /** Absolute URL: this adapter spans three hosts, so a path alone is ambiguous. */
    url: string;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const response = await providerFetch(context, input.url, {
    operation: new URL(input.url).pathname,
    method: input.method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (!response.ok) {
    throw toGoogleError(
      response.status,
      response.json,
      response.headers,
      `Google Business Profile returned ${response.status}.`,
    );
  }

  return (response.json ?? {}) as T;
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new GoogleBusinessError(401, 'UNAUTHENTICATED', 'This connection has no Google access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    throw new GoogleBusinessError(
      500,
      'MISSING_APP',
      'No Google application is configured. Add its client id and secret before connecting.',
    );
  }
  return app;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'google_business_profile',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      // `mediaFormat: VIDEO` exists on the resource, but Google documents only PHOTO as
      // supported for local posts. Claiming video would make preflight approve posts the
      // API rejects (Rule 2 — do not assume).
      video: false,
      // `scheduledTime` publishes the post at a chosen instant, provider-side.
      native_scheduling: true,
    },
    actions: {
      delete_post: true,
      edit_post: true,
      analytics_read: false,
    },
    constraints: {
      max_text_length: MAX_SUMMARY,
      max_media_count: MAX_MEDIA_COUNT,
      max_image_bytes: MAX_IMAGE_BYTES,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supports_alt_text: false,
    },
  });
}

interface GbpAccount {
  name?: string;
  accountName?: string;
  type?: string;
}

interface GbpLocation {
  name?: string;
  title?: string;
  storeCode?: string;
  websiteUri?: string;
}

async function fetchAccounts(
  context: ProviderCallContext,
  accessToken: string,
): Promise<GbpAccount[]> {
  const data = await call<{ accounts?: GbpAccount[] }>(context, {
    accessToken,
    method: 'GET',
    url: `${ACCOUNTS_BASE}/accounts?pageSize=100`,
  });
  return data.accounts ?? [];
}

function identityOf(account: GbpAccount, grantedScopes: readonly string[]): ConnectionIdentity {
  return {
    // `accounts/{accountId}` — the full resource name, because every downstream call
    // needs it as a path segment rather than as a bare id.
    externalAccountId: account.name ?? '',
    displayName: account.accountName ?? 'Business Profile account',
    handle: null,
    avatarUrl: null,
    accountType: account.type ?? null,
    grantedScopes,
  };
}

/** `topicType` decides the shape of the body; STANDARD is the only one needing no extras. */
function resolveTopicType(providerOptions: Readonly<Record<string, unknown>>): string {
  const requested = providerOptions.topicType;
  return typeof requested === 'string' && (TOPIC_TYPES as readonly string[]).includes(requested)
    ? requested
    : 'STANDARD';
}

export function createGoogleBusinessProfileAdapter(): SocialProviderAdapter {
  return {
    provider: 'google_business_profile',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: GBP_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      // There is exactly one scope. Either it was granted or nothing works, which makes
      // this the simplest effective-capability resolution in the product.
      if (!hasScopes(granted, [SCOPE_MANAGE])) {
        for (const capability of ['text_only', 'image', 'native_scheduling']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_MANAGE]));
        }
        restrictions.push(scopeRestriction('actions.delete_post', [SCOPE_MANAGE]));
        restrictions.push(scopeRestriction('actions.edit_post', [SCOPE_MANAGE]));
      }

      return restrictCapabilities(generic, restrictions);
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
        // Both are required to receive a refresh token. Without them the connection dies
        // an hour later with nothing to renew it.
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');

        return { authorizationUrl: url.toString(), state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new GoogleBusinessError(
            400,
            input.query.error,
            input.query.error === 'access_denied'
              ? 'Google authorization was declined.'
              : (input.query.error_description ?? 'Google authorization failed.'),
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new GoogleBusinessError(
            400,
            'MISSING_CODE',
            'Google did not return an authorization code.',
          );
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
          throw new GoogleBusinessError(
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
        const accounts = await fetchAccounts(input.context, token.access_token);
        const account = accounts[0];

        if (!account?.name) {
          // A Google account with no Business Profile authorizes fine and can publish
          // nothing. Saying so now beats a confusing permission error at publish time.
          throw new GoogleBusinessError(
            403,
            'NO_ACCOUNT',
            'This Google account manages no Business Profile. Claim a business, then connect again.',
          );
        }

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: account.name,
            ...(token.expires_in !== undefined
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
            grantedScopes,
            metadata: {},
          },
          identity: identityOf(account, grantedScopes),
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);

        if (!input.credentials.refreshToken) {
          throw new GoogleBusinessError(
            401,
            'NO_REFRESH_TOKEN',
            'This Business Profile connection has no refresh token and must be reconnected.',
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
          throw new GoogleBusinessError(
            response.status,
            body.error ?? 'REFRESH_FAILED',
            body.error_description ?? 'Could not refresh the Google token.',
          );
        }

        const token = response.json as { access_token: string; expires_in?: number };

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // Google does not rotate the refresh token on refresh; keeping the existing
            // one is correct here.
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

        if (!response.ok && response.status !== 400) {
          throw new GoogleBusinessError(response.status, 'REVOKE_FAILED', 'Could not revoke the Google token.');
        }
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const accounts = await fetchAccounts(input.context, accessTokenOf(input.credentials));
        const account =
          accounts.find((item) => item.name === input.credentials.externalAccountId) ?? accounts[0];

        if (!account?.name) {
          throw new GoogleBusinessError(
            403,
            'NO_ACCOUNT',
            'This connection no longer manages a Business Profile.',
          );
        }
        return identityOf(account, input.credentials.grantedScopes);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const accessToken = accessTokenOf(input.credentials);
        const accounts = await fetchAccounts(input.context, accessToken);
        const destinations: ProviderDestination[] = [];

        for (const account of accounts) {
          if (!account.name) continue;

          // `readMask` is mandatory on this endpoint. Omitting it returns a 400 that
          // complains about a field mask rather than about anything the caller did.
          const url = new URL(`${INFORMATION_BASE}/${account.name}/locations`);
          url.searchParams.set('readMask', 'name,title,storeCode,websiteUri');
          url.searchParams.set('pageSize', '100');

          const data = await call<{ locations?: GbpLocation[] }>(input.context, {
            accessToken,
            method: 'GET',
            url: url.toString(),
          });

          for (const location of data.locations ?? []) {
            if (!location.name) continue;

            destinations.push({
              // The full v4 path, because publishing needs
              // `accounts/{account}/locations/{location}` and a bare location id cannot be
              // reassembled without knowing which account it came from.
              externalId: `${account.name}/${location.name}`,
              displayName: location.title ?? 'Business location',
              handle: location.storeCode ?? null,
              avatarUrl: null,
              kind: 'location',
              metadata: {
                accountName: account.name,
                locationName: location.name,
                websiteUri: location.websiteUri ?? null,
              },
            });
          }
        }

        return destinations;
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const topicType = resolveTopicType(content.providerOptions);

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_SUMMARY, { code: 'TEXT_TOO_LONG', truncatable: true }),
            f.checkMediaCount(content.media.length, MAX_MEDIA_COUNT),
          ),
        );

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Business Profile post needs a summary or a photo.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            // Google documents only PHOTO for local posts. Accepting a video here would
            // approve a post the API rejects.
            results.push(
              f.error('MEDIA_TYPE_UNSUPPORTED', 'A Business Profile post takes a photo, not a video.', {
                field: `media[${index}]`,
                agentAction: 'remove_media',
              }),
            );
            return;
          }

          results.push(
            ...f.collect(
              f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index),
              f.checkMediaSize(item.bytes, MAX_IMAGE_BYTES, index),
            ),
          );

          // Google rejects anything below 250px on either edge. Checking it here is only
          // possible because media is probed on upload (plan §31).
          if (
            (item.width !== null && item.width < MIN_IMAGE_DIMENSION) ||
            (item.height !== null && item.height < MIN_IMAGE_DIMENSION)
          ) {
            results.push(
              f.error(
                'MEDIA_DIMENSIONS_TOO_SMALL',
                `A Business Profile photo must be at least ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION} pixels.`,
                { field: `media[${index}]`, agentAction: 'create_media_variant' },
              ),
            );
          }
        });

        if (typeof content.providerOptions.topicType === 'string' &&
          !(TOPIC_TYPES as readonly string[]).includes(content.providerOptions.topicType)) {
          results.push(
            f.error('TOPIC_TYPE_INVALID', `"${content.providerOptions.topicType}" is not a post type.`, {
              field: 'providerOptions.topicType',
              agentAction: 'choose_a_valid_topic_type',
            }),
          );
        }

        // An EVENT post is rejected without a title and a schedule; the fields are not
        // optional the way the resource's shape suggests.
        if (topicType === 'EVENT' || topicType === 'OFFER') {
          const event = content.providerOptions.event as { title?: unknown; schedule?: unknown } | undefined;
          if (!event || typeof event.title !== 'string' || event.title.trim() === '') {
            results.push(
              f.error('EVENT_TITLE_REQUIRED', `A ${topicType} post needs an event title.`, {
                field: 'providerOptions.event.title',
                agentAction: 'add_event_details',
              }),
            );
          }
          if (!event?.schedule) {
            results.push(
              f.error('EVENT_SCHEDULE_REQUIRED', `A ${topicType} post needs an event schedule.`, {
                field: 'providerOptions.event.schedule',
                agentAction: 'add_event_details',
              }),
            );
          }
        }

        const cta = content.providerOptions.callToAction as
          | { actionType?: unknown; url?: unknown }
          | undefined;
        if (cta) {
          if (
            typeof cta.actionType !== 'string' ||
            !(ACTION_TYPES as readonly string[]).includes(cta.actionType)
          ) {
            results.push(
              f.error('CALL_TO_ACTION_INVALID', 'That is not a Business Profile call-to-action type.', {
                field: 'providerOptions.callToAction.actionType',
                agentAction: 'choose_a_valid_action_type',
              }),
            );
          } else if (cta.actionType !== 'CALL' && typeof cta.url !== 'string' && !content.linkUrl) {
            // Every action except CALL sends the customer somewhere, so it needs a URL.
            results.push(
              f.error('CALL_TO_ACTION_URL_REQUIRED', `A ${cta.actionType} button needs a URL.`, {
                field: 'providerOptions.callToAction.url',
                agentAction: 'add_a_link',
              }),
            );
          }
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        // Nothing to upload: Google fetches the photo from `sourceUrl` while creating the
        // post, so the signed media URL is handed over directly. The URL must be publicly
        // reachable for the lifetime of the call, which the engine's signed URLs are.
        const photo = input.content.media.find((item) => item.kind === 'image');
        return {
          state: photo ? { sourceUrl: photo.downloadUrl } : {},
          providerMediaIds: [],
        };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const options = input.content.providerOptions;
        const topicType = resolveTopicType(options);
        const sourceUrl = input.prepared.state.sourceUrl as string | undefined;

        const body: Record<string, unknown> = {
          // Required. Google rejects a post without one rather than inferring it.
          languageCode: typeof options.languageCode === 'string' ? options.languageCode : 'en-US',
          summary: input.content.text,
          topicType,
        };

        if (sourceUrl) {
          body.media = [{ mediaFormat: 'PHOTO', sourceUrl }];
        }

        const cta = options.callToAction as { actionType?: string; url?: string } | undefined;
        if (cta?.actionType) {
          body.callToAction = {
            actionType: cta.actionType,
            // CALL uses the location's own phone number and takes no URL.
            ...(cta.actionType !== 'CALL'
              ? { url: cta.url ?? input.content.linkUrl ?? undefined }
              : {}),
          };
        }

        if (topicType === 'EVENT' || topicType === 'OFFER') {
          body.event = options.event;
        }
        if (topicType === 'OFFER' && options.offer) {
          body.offer = options.offer;
        }
        if (topicType === 'ALERT' && typeof options.alertType === 'string') {
          body.alertType = options.alertType;
        }
        if (typeof options.scheduledTime === 'string') {
          // Provider-side scheduling: Google holds the post and publishes it itself.
          body.scheduledTime = options.scheduledTime;
        }

        // No idempotency key exists on this endpoint, so a retried create makes a second
        // post. `findPossibleDuplicate` below is what stands in for one.
        const created = await call<{ name?: string; searchUrl?: string; state?: string; createTime?: string }>(
          input.context,
          {
            accessToken,
            method: 'POST',
            url: `${POSTS_BASE}/${input.target.destinationExternalId}/localPosts`,
            body,
          },
        );

        if (!created.name) {
          throw new GoogleBusinessError(502, 'MISSING_POST_ID', 'Google did not return a post id.');
        }

        // LIVE is published; PROCESSING and SCHEDULED are not yet visible and REJECTED is
        // a content-policy failure the poller will surface.
        const live = created.state === 'LIVE';

        return {
          outcome: live ? 'published' : 'processing',
          externalPostId: created.name,
          externalUrl: created.searchUrl ?? null,
          publishedAt: live
            ? (created.createTime ? new Date(created.createTime).toISOString() : new Date().toISOString())
            : null,
          statusHandle: created.name,
          metadata: { topicType },
        };
      },

      async status(input) {
        const post = await call<{ name?: string; state?: string; searchUrl?: string; createTime?: string }>(
          input.context,
          {
            accessToken: accessTokenOf(input.credentials),
            method: 'GET',
            url: `${POSTS_BASE}/${input.statusHandle}`,
          },
        );

        switch (post.state) {
          case 'LIVE':
          case 'RECURRING':
            return {
              outcome: 'published',
              externalPostId: input.statusHandle,
              externalUrl: post.searchUrl ?? null,
              publishedAt: post.createTime
                ? new Date(post.createTime).toISOString()
                : new Date().toISOString(),
            };
          case 'REJECTED':
            return {
              outcome: 'failed',
              externalPostId: null,
              externalUrl: null,
              publishedAt: null,
              failureReason: 'Google rejected this post for a content policy violation.',
            };
          default:
            // PROCESSING and SCHEDULED are both still in flight. A scheduled post can stay
            // here for as long as the caller asked it to.
            return { outcome: 'processing', externalPostId: null, externalUrl: null, publishedAt: null };
        }
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. Local posts are listed per location, so this is exact — a post
        // can only be at the location it was created for.
        if (!hasScopes(input.credentials.grantedScopes, [SCOPE_MANAGE])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires the ${SCOPE_MANAGE} permission, which this connection did not grant.`,
          };
        }

        const data = await call<{
          localPosts?: { name?: string; summary?: string; createTime?: string; searchUrl?: string }[];
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          url: `${POSTS_BASE}/${input.target.destinationExternalId}/localPosts?pageSize=20`,
        });

        const wanted = input.content.text.trim();
        const attemptedAfter = Date.parse(input.attemptedAfter);
        const posts = data.localPosts ?? [];

        for (const post of posts) {
          const createdAt = post.createTime ? Date.parse(post.createTime) : undefined;
          if (createdAt !== undefined && createdAt < attemptedAfter - 60_000) continue;

          if ((post.summary ?? '').trim() === wanted && post.name) {
            return {
              conclusion: 'found',
              externalPostId: post.name,
              ...(post.searchUrl ? { externalUrl: post.searchUrl } : {}),
              ...(createdAt !== undefined ? { publishedAt: new Date(createdAt).toISOString() } : {}),
            };
          }
        }

        if (wanted === '') {
          // A photo-only post cannot be matched on text, and matching on timing alone is
          // the reasoning that duplicates posts.
          return {
            conclusion: 'indeterminate',
            reason: 'The post has no summary, so it cannot be identified among recent posts.',
          };
        }

        if (posts.length >= 20) {
          return {
            conclusion: 'indeterminate',
            reason: 'The local post page was full, so a matching post cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          await call(input.context, {
            accessToken: accessTokenOf(input.credentials),
            method: 'DELETE',
            url: `${POSTS_BASE}/${input.externalPostId}`,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          if (error instanceof GoogleBusinessError && error.status === 404) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return {
          code: 'PROVIDER_TIMEOUT',
          message: `Google Business Profile timed out during ${context.operation}.`,
        };
      }
      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Google Business Profile was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof GoogleBusinessError) {
        switch (error.code) {
          case 'UNAUTHENTICATED':
          case 'NO_REFRESH_TOKEN':
          case 'invalid_grant':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'PERMISSION_DENIED':
            // Almost always the project's API access rather than a missing scope: Google
            // grants Business Profile access per project by application, and until that is
            // approved every call fails this way.
            return {
              code: 'AUTH_SCOPE_MISSING',
              message: `${error.message} Google grants Business Profile API access per project by application; check that the request was approved.`,
              status: error.status,
            };
          case 'RESOURCE_EXHAUSTED':
            return {
              code: 'DAILY_QUOTA_EXCEEDED',
              message: error.message,
              status: error.status,
            };
          case 'NO_ACCOUNT':
            return { code: 'ACCOUNT_NOT_ELIGIBLE', message: error.message, status: error.status };
          case 'NOT_FOUND':
            return { code: 'DESTINATION_NOT_FOUND', message: error.message, status: error.status };
          case 'INVALID_ARGUMENT':
            return { code: 'VALIDATION_FAILED', message: error.message, status: error.status };
          case 'FAILED_PRECONDITION':
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
          return { code: 'AUTH_EXPIRED', message: 'Google rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'Google is rate limiting this project.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Google returned a server error.', status };
        }
      }

      // Rule 14 — not auto-retried. There is no idempotency key, so a blind retry posts
      // to the business listing twice.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Google Business Profile failure during ${context.operation}.`,
      };
    },
  };
}
