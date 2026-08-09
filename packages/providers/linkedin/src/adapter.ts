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
 * LinkedIn adapter (Posts API).
 *
 * Official documentation consulted (Rule 2):
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 *   https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *
 * The first commercial provider (plan §62.2) and the slowest to get access to: LinkedIn
 * grants the Community Management API only to registered legal organisations, through a
 * two-tier review. That is why this adapter is written before approval rather than after —
 * the credentials drop into `provider_apps` and it starts working (plan §23).
 *
 * Three things about the Posts API that shape this file:
 *
 *   Versioned by header, not by URL. Every request carries `Linkedin-Version: YYYYMM`,
 *   and LinkedIn sunsets versions on a schedule. Pinning it here — rather than sending
 *   "latest" — means an upgrade is a deliberate change with a test run, not a silent
 *   breakage on the day LinkedIn retires a version.
 *
 *   The created post id is in a response HEADER, not the body. `x-restli-id` carries the
 *   URN; the body is empty. Reading the body would find nothing and conclude the publish
 *   failed.
 *
 *   Member and organisation are different authors with different permissions. Posting as
 *   a person needs `w_member_social`; posting as a company page needs
 *   `w_organization_social` plus an admin role on that page.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://api.linkedin.com/rest';

/**
 * Pinned API version.
 *
 * LinkedIn sunsets versions on a published schedule, so this is deliberately a constant to
 * be reviewed rather than a computed "current month" — which would silently move every
 * month and break on whichever release changes a field.
 */
const LINKEDIN_VERSION = '202606';

/**
 * Commentary limit.
 *
 * LinkedIn does not publish this in the Posts API reference; the documented failure is
 * `FIELD_LENGTH_TOO_LONG`. 3000 is the limit the product enforces and the figure the
 * developer community consistently reports. Treated as a validation ceiling rather than a
 * certainty — if LinkedIn rejects a shorter post, the normalized error still explains it.
 */
const MAX_COMMENTARY = 3000;

/** MultiImage supports several images on an organic post. */
const MAX_IMAGES = 20;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'] as const;

const AUTHOR_URN_KEY = 'authorUrn';

/** Scopes this adapter needs, by author type. */
const MEMBER_WRITE = 'w_member_social';
const ORG_WRITE = 'w_organization_social';
const MEMBER_READ = 'r_member_social';
const ORG_READ = 'r_organization_social';

export class LinkedInError extends Error {
  readonly status: number;
  /** LinkedIn's documented machine code, e.g. `FIELD_LENGTH_TOO_LONG`. */
  readonly code: string | undefined;
  readonly retryAfter: string | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfter?: string) {
    super(message);
    this.name = 'LinkedInError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface LinkedInErrorBody {
  code?: string;
  message?: string;
  serviceErrorCode?: number;
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
    /** LinkedIn's Rest.li dialect needs this on updates, deletes and finders. */
    restliMethod?: string;
    timeoutMs?: number;
  },
): Promise<{ data: T; headers: Headers }> {
  const response = await providerFetch(context, `${API_BASE}${input.path}`, {
    operation: input.path.split('?')[0] ?? input.path,
    method: input.method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      // Both headers are required on every call. Omitting either produces an error that
      // reads like a malformed body rather than a missing header.
      'X-Restli-Protocol-Version': '2.0.0',
      'Linkedin-Version': LINKEDIN_VERSION,
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(input.restliMethod ? { 'X-RestLi-Method': input.restliMethod } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (!response.ok) {
    const body = (response.json ?? {}) as LinkedInErrorBody;
    throw new LinkedInError(
      response.status,
      body.code,
      body.message ?? `LinkedIn returned ${response.status}.`,
      parseRetryAfter(response.headers),
    );
  }

  return { data: (response.json ?? {}) as T, headers: response.headers };
}

function accessTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.accessToken) {
    throw new LinkedInError(401, 'EMPTY_ACCESS_TOKEN', 'This connection has no LinkedIn access token.');
  }
  return credentials.accessToken;
}

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    // Rule 14 — say precisely what is missing. LinkedIn is OAuth, so an app is mandatory,
    // and "no LinkedIn application configured" is far more actionable than a null deref.
    throw new LinkedInError(
      500,
      'MISSING_APP',
      'No LinkedIn application is configured. Add its client id and secret before connecting.',
    );
  }
  return app;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'linkedin',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      // MultiImage. Organic carousels are explicitly not supported by the Posts API —
      // carousel is a sponsored-only content type.
      carousel: true,
      link_preview: true,
      poll: true,
    },
    actions: {
      delete_post: true,
      edit_post: true,
      comments_read: true,
      comments_reply: true,
    },
    constraints: {
      max_text_length: MAX_COMMENTARY,
      max_media_count: MAX_IMAGES,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: ['video/mp4'],
      supports_alt_text: true,
      allowed_privacy_levels: ['PUBLIC', 'CONNECTIONS'],
    },
  });
}

interface UserInfo {
  sub: string;
  name?: string;
  picture?: string;
}

interface OrganizationAcl {
  organization: string;
  role: string;
  state: string;
}

export function createLinkedInAdapter(): SocialProviderAdapter {
  return {
    provider: 'linkedin',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: LINKEDIN_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      // Publishing needs one of the two write scopes. Which one depends on whether the
      // destination is a person or a company page, and a connection may hold either.
      const canWrite =
        hasScopes(granted, [MEMBER_WRITE]) || hasScopes(granted, [ORG_WRITE]);

      if (!canWrite) {
        for (const capability of ['text_only', 'image', 'video', 'carousel', 'link_preview', 'poll']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [MEMBER_WRITE, ORG_WRITE]));
        }
      }

      // r_member_social is documented as restricted and granted only to approved
      // applications, so reading a member's own posts often is not available even when
      // writing is.
      if (!hasScopes(granted, [MEMBER_READ]) && !hasScopes(granted, [ORG_READ])) {
        restrictions.push(scopeRestriction('actions.comments_read', [ORG_READ, MEMBER_READ]));
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes =
          input.requestedScopes.length > 0
            ? input.requestedScopes
            : [MEMBER_WRITE, ORG_WRITE, ORG_READ, 'openid', 'profile'];

        const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', app.clientId);
        url.searchParams.set('redirect_uri', app.redirectUri);
        // The state is round-tripped through LinkedIn and checked on the way back. It is
        // the CSRF defence for the whole flow (plan §21.1).
        url.searchParams.set('state', input.state);
        url.searchParams.set('scope', scopes.join(' '));

        return { authorizationUrl: url.toString(), state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        // LinkedIn returns an error in the query string rather than as an HTTP status
        // when the member declines, so it has to be read explicitly.
        if (input.query.error) {
          throw new LinkedInError(
            400,
            input.query.error,
            input.query.error_description ?? 'LinkedIn authorization was declined.',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new LinkedInError(400, 'MISSING_CODE', 'LinkedIn did not return an authorization code.');
        }

        // The token endpoint is form-encoded and lives outside /rest, so it does not go
        // through `call`.
        const tokenResponse = await providerFetch(
          input.context,
          'https://www.linkedin.com/oauth/v2/accessToken',
          {
            operation: 'accessToken',
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              client_id: app.clientId,
              client_secret: app.clientSecret,
              redirect_uri: app.redirectUri,
            }).toString(),
          },
        );

        if (!tokenResponse.ok) {
          const body = (tokenResponse.json ?? {}) as { error_description?: string };
          throw new LinkedInError(
            tokenResponse.status,
            'TOKEN_EXCHANGE_FAILED',
            body.error_description ?? 'Could not exchange the authorization code.',
          );
        }

        const token = tokenResponse.json as {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
          refresh_token_expires_in?: number;
          scope?: string;
        };

        const { data: user } = await call<UserInfo>(input.context, {
          accessToken: token.access_token,
          method: 'GET',
          path: '/../v2/userinfo',
        });

        const grantedScopes = token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [];

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            externalAccountId: user.sub,
            // Rule 15 — UTC ISO-8601. Used by the proactive refresh sweep.
            expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
            grantedScopes,
            metadata: { [AUTHOR_URN_KEY]: `urn:li:person:${user.sub}` },
          },
          identity: {
            externalAccountId: user.sub,
            displayName: user.name ?? 'LinkedIn member',
            handle: null,
            avatarUrl: user.picture ?? null,
            accountType: 'member',
            grantedScopes,
          },
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);

        // Refresh tokens are not granted to every LinkedIn application. Without one the
        // member must re-authorize, and saying so beats failing obscurely mid-publish.
        if (!input.credentials.refreshToken) {
          throw new LinkedInError(
            401,
            'NO_REFRESH_TOKEN',
            'This LinkedIn connection has no refresh token and must be reconnected.',
          );
        }

        const response = await providerFetch(
          input.context,
          'https://www.linkedin.com/oauth/v2/accessToken',
          {
            operation: 'refreshToken',
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: input.credentials.refreshToken,
              client_id: app.clientId,
              client_secret: app.clientSecret,
            }).toString(),
          },
        );

        if (!response.ok) {
          throw new LinkedInError(response.status, 'REFRESH_FAILED', 'Could not refresh the LinkedIn token.');
        }

        const token = response.json as {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
        };

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.access_token,
            // LinkedIn may or may not rotate the refresh token; keeping the old one when
            // none is returned avoids discarding a still-valid credential.
            refreshToken: token.refresh_token ?? input.credentials.refreshToken,
            expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
          },
          rotated: true,
        };
      },

      async revoke() {
        // LinkedIn provides no token revocation endpoint for this flow. Access is removed
        // by the member in their LinkedIn settings; the engine records the disconnect.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const { data: user } = await call<UserInfo>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: '/../v2/userinfo',
        });

        return {
          externalAccountId: user.sub,
          displayName: user.name ?? 'LinkedIn member',
          handle: null,
          avatarUrl: user.picture ?? null,
          accountType: 'member',
          grantedScopes: input.credentials.grantedScopes,
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const accessToken = accessTokenOf(input.credentials);
        const destinations: ProviderDestination[] = [];

        // The member themselves is always a destination when member posting is granted.
        const authorUrn = input.credentials.metadata[AUTHOR_URN_KEY];
        if (typeof authorUrn === 'string' && hasScopes(input.credentials.grantedScopes, [MEMBER_WRITE])) {
          destinations.push({
            externalId: authorUrn,
            displayName: 'Personal profile',
            handle: null,
            avatarUrl: null,
            kind: 'member',
            metadata: {},
          });
        }

        // Company pages the member administers. Requires an organization scope, so a
        // connection without one legitimately returns only the personal profile rather
        // than failing.
        if (!hasScopes(input.credentials.grantedScopes, [ORG_READ])) return destinations;

        try {
          const { data } = await call<{ elements: OrganizationAcl[] }>(input.context, {
            accessToken,
            method: 'GET',
            path: '/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
            restliMethod: 'FINDER',
          });

          for (const acl of data.elements ?? []) {
            destinations.push({
              externalId: acl.organization,
              displayName: acl.organization.replace('urn:li:organization:', 'Company page '),
              handle: null,
              avatarUrl: null,
              kind: 'organization',
              metadata: { role: acl.role },
            });
          }
        } catch (error) {
          // A missing organization permission must not lose the personal destination that
          // was already resolved.
          if (!(error instanceof LinkedInError) || error.status !== 403) throw error;
        }

        return destinations;
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_COMMENTARY, {
              code: 'TEXT_TOO_LONG',
              truncatable: true,
            }),
            f.checkMediaCount(content.media.length, MAX_IMAGES),
          ),
        );

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'A LinkedIn post needs commentary or media.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        const videos = content.media.filter((item) => item.kind === 'video');
        if (videos.length > 0 && content.media.length > videos.length) {
          // The Posts API takes a single `content.media`, so a post is images or a video,
          // never both. Discovering that at publish time would waste an upload.
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'LinkedIn cannot mix video and images in one post.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }

        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'A LinkedIn post carries at most one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'image') {
            results.push(...f.collect(f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index)));
          }
        });

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = accessTokenOf(input.credentials);
        const images: string[] = [];

        // Images API: initialize an upload to get a URN and an upload URL, PUT the bytes,
        // then reference the URN in the post. Done here rather than in `publish` so the
        // slow retry-prone part is separated from the single irreversible act.
        for (const media of input.content.media) {
          if (media.kind !== 'image') continue;

          const { data: initialized } = await call<{
            value: { uploadUrl: string; image: string };
          }>(input.context, {
            accessToken,
            method: 'POST',
            path: '/images?action=initializeUpload',
            body: { initializeUploadRequest: { owner: input.target.destinationExternalId } },
          });

          const source = await fetch(media.downloadUrl, { signal: input.context.signal });
          if (!source.ok) {
            throw new LinkedInError(source.status, 'MEDIA_FETCH_FAILED', 'Could not read the media file.');
          }

          const upload = await providerFetch(input.context, initialized.value.uploadUrl, {
            operation: 'uploadImage',
            method: 'PUT',
            headers: { authorization: `Bearer ${accessToken}` },
            body: await source.arrayBuffer(),
            timeoutMs: 120_000,
          });

          if (!upload.ok) {
            throw new LinkedInError(upload.status, 'UPLOAD_FAILED', 'LinkedIn rejected the image upload.');
          }

          images.push(initialized.value.image);
        }

        return { state: { images }, providerMediaIds: images };
      },

      async publish(input) {
        const accessToken = accessTokenOf(input.credentials);
        const author = input.target.destinationExternalId;
        const images = (input.prepared.state.images as string[] | undefined) ?? [];

        const record: Record<string, unknown> = {
          author,
          commentary: input.content.text,
          visibility: (input.content.providerOptions.visibility as string) ?? 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        };

        if (images.length === 1) {
          record.content = { media: { id: images[0] } };
        } else if (images.length > 1) {
          // MultiImage is the organic multi-photo type. Carousel is sponsored-only, so
          // using it here would be rejected.
          record.content = {
            multiImage: { images: images.map((id) => ({ id })) },
          };
        } else if (input.content.linkUrl) {
          // LinkedIn deliberately does not scrape URLs for article posts, so title and
          // description must be supplied rather than left for it to fetch.
          record.content = {
            article: {
              source: input.content.linkUrl,
              title: (input.content.providerOptions.linkTitle as string) ?? input.content.linkUrl,
              description: (input.content.providerOptions.linkDescription as string) ?? '',
            },
          };
        }

        const { headers } = await call<unknown>(input.context, {
          accessToken,
          method: 'POST',
          path: '/posts',
          body: record,
        });

        // The created id is in a HEADER, not the body — the body is empty. Reading the
        // body would find nothing and wrongly conclude the publish failed.
        const urn = headers.get('x-restli-id');
        if (!urn) {
          throw new LinkedInError(502, 'MISSING_POST_ID', 'LinkedIn did not return a post id.');
        }

        return {
          outcome: 'published',
          externalPostId: urn,
          externalUrl: `https://www.linkedin.com/feed/update/${urn}/`,
          publishedAt: new Date().toISOString(),
          metadata: { author },
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. The author finder needs a read scope that LinkedIn documents as
        // restricted for members, so this genuinely cannot always run.
        const granted = input.credentials.grantedScopes;
        const isOrganization = input.target.destinationExternalId.includes(':organization:');
        const needed = isOrganization ? ORG_READ : MEMBER_READ;

        if (!hasScopes(granted, [needed])) {
          return {
            conclusion: 'indeterminate',
            reason: `Verifying requires the ${needed} permission, which this connection did not grant.`,
          };
        }

        const author = encodeURIComponent(input.target.destinationExternalId);
        const { data } = await call<{
          elements: { id: string; commentary?: string; createdAt?: number }[];
        }>(input.context, {
          accessToken: accessTokenOf(input.credentials),
          method: 'GET',
          path: `/posts?author=${author}&q=author&count=50&sortBy=CREATED`,
          restliMethod: 'FINDER',
        });

        const attemptedAfter = Date.parse(input.attemptedAfter);
        const wanted = input.content.text.trim();

        for (const post of data.elements ?? []) {
          if (post.createdAt !== undefined && post.createdAt < attemptedAfter) continue;
          if ((post.commentary ?? '').trim() === wanted) {
            return {
              conclusion: 'found',
              externalPostId: post.id,
              externalUrl: `https://www.linkedin.com/feed/update/${post.id}/`,
              publishedAt: post.createdAt ? new Date(post.createdAt).toISOString() : undefined,
            };
          }
        }

        // The finder returns a page, not the whole history. A full page means an older
        // match could sit just outside it, so absence is not provable (Rule 14).
        if ((data.elements ?? []).length >= 50) {
          return {
            conclusion: 'indeterminate',
            reason: 'The author feed page was full, so an earlier matching post cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          await call(input.context, {
            accessToken: accessTokenOf(input.credentials),
            method: 'DELETE',
            path: `/posts/${encodeURIComponent(input.externalPostId)}`,
            restliMethod: 'DELETE',
          });
          return { alreadyAbsent: false };
        } catch (error) {
          // LinkedIn documents deletion as idempotent, and a 404 means it is already gone.
          if (error instanceof LinkedInError && error.status === 404) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `LinkedIn timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return { code: 'PROVIDER_UNAVAILABLE', message: `LinkedIn was unreachable during ${context.operation}.` };
      }

      if (error instanceof LinkedInError) {
        // Branch on LinkedIn's documented machine code first; the human message is not a
        // stable contract.
        switch (error.code) {
          case 'FIELD_LENGTH_TOO_LONG':
            return { code: 'TEXT_TOO_LONG', message: error.message, status: error.status };
          case 'ACCESS_DENIED':
            return { code: 'AUTH_SCOPE_MISSING', message: error.message, status: error.status };
          case 'EMPTY_ACCESS_TOKEN':
          case 'NO_REFRESH_TOKEN':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'MISSING_FIELD':
          case 'INVALID_VALUE_FOR_FIELD':
          case 'INVALID_URN_TYPE':
          case 'INVALID_URN_ID':
          case 'INVALID_VALUE_BLANK_FIELD':
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
        if (error.status === 409) {
          // Documented as a write conflict that should be retried.
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
          return { code: 'AUTH_EXPIRED', message: 'LinkedIn rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'LinkedIn is rate limiting this account.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'LinkedIn returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried, because a retry could
      // duplicate a post we cannot prove did not publish.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized LinkedIn failure during ${context.operation}.`,
      };
    },
  };
}
