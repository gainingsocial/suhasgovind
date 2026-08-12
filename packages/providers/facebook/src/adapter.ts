import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildAuthorizationUrl,
  exchangeCodeForLongLivedToken,
  exchangeForLongLivedToken,
  GRAPH_HOST,
  GraphError,
  graphCall,
  handleMetaWebhook,
  inspectToken,
  listManagedPages,
  normalizeGraphError,
  requireAccessToken,
  revokePermissions,
  TASK_CREATE_CONTENT,
} from '@gs/provider-meta-core';
import {
  buildCapabilities,
  findings as f,
  hasScopes,
  restrictCapabilities,
  scopeRestriction,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderAppCredentials,
  type ProviderCredentials,
  type ProviderDestination,
  type SocialProviderAdapter,
} from '@gs/provider-kit';

/**
 * Facebook Pages adapter.
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.facebook.com/docs/pages-api/posts
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens
 *
 * Three facts shape this file.
 *
 *   **Only Pages.** Meta removed the ability to publish to a personal profile in 2018.
 *   Every destination here is a Page, and a customer expecting to post to their own
 *   timeline needs to be told that at connect time, not at publish time.
 *
 *   **A Page token publishes; a user token does not.** `/me/accounts` returns a distinct
 *   access token per Page, and that is what every write below uses. Posting with the user
 *   token yields a permission error that reads like a missing scope, sending you off to
 *   re-request permissions that were never the problem.
 *
 *   **Multi-photo posts are three calls, not one.** Each photo is uploaded unpublished,
 *   and the resulting ids are attached to a single feed post. There is no endpoint that
 *   takes several images at once.
 */

export const ADAPTER_VERSION = '1.0.0';

/**
 * Facebook does not publish a hard limit for a Page post's message, and the practical
 * ceiling is far above anything a social post uses. 63,206 is the figure Meta's own
 * composer enforces and the number the developer community consistently reports.
 * Treated as a validation ceiling, not a certainty — if Facebook rejects something
 * shorter, the normalized error still explains it.
 */
const MAX_MESSAGE = 63_206;

/** Attaching more than this to one post is not documented as supported. */
const MAX_PHOTOS = 10;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;

/** Permissions this adapter needs. All three are subject to Meta App Review. */
const SCOPE_MANAGE_POSTS = 'pages_manage_posts';
const SCOPE_READ_ENGAGEMENT = 'pages_read_engagement';
const SCOPE_SHOW_LIST = 'pages_show_list';
const SCOPE_PUBLISH_VIDEO = 'publish_video';
const SCOPE_MANAGE_ENGAGEMENT = 'pages_manage_engagement';

const DEFAULT_SCOPES = [
  SCOPE_SHOW_LIST,
  SCOPE_READ_ENGAGEMENT,
  SCOPE_MANAGE_POSTS,
  SCOPE_MANAGE_ENGAGEMENT,
  SCOPE_PUBLISH_VIDEO,
  // Required alongside the Pages permissions since the Instagram/Pages consolidation;
  // without it `/me/accounts` returns an empty list rather than an error, which looks
  // exactly like a user who administers no Pages.
  'business_management',
] as const;

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    // Rule 14 — name what is missing. Facebook is OAuth, so an app is mandatory.
    throw new GraphError(
      500,
      {
        message:
          'No Meta application is configured. Add its App ID and App Secret before connecting a Facebook Page.',
      },
      '',
    );
  }
  return app;
}

/** The Page token lives on the destination credential, not the connection credential. */
function pageTokenOf(credentials: ProviderCredentials): string {
  return requireAccessToken(credentials, 'Facebook');
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'facebook',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      // Several photos on one post, via unpublished uploads plus `attached_media`.
      carousel: true,
      link_preview: true,
    },
    actions: {
      delete_post: true,
      comments_read: true,
      comments_reply: true,
    },
    constraints: {
      max_text_length: MAX_MESSAGE,
      max_media_count: MAX_PHOTOS,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      supports_alt_text: true,
      allowed_privacy_levels: ['PUBLIC'],
    },
  });
}

interface FeedPost {
  id: string;
  message?: string;
  created_time?: string;
}

export function createFacebookAdapter(): SocialProviderAdapter {
  return {
    provider: 'facebook',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [SCOPE_MANAGE_POSTS])) {
        for (const capability of ['text_only', 'image', 'video', 'carousel', 'link_preview']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_MANAGE_POSTS]));
          }
      } else if (!hasScopes(granted, [SCOPE_PUBLISH_VIDEO])) {
        // Video is a separate permission from everything else, and a Page connection
        // frequently has one without the other. Saying so up front beats a publish that
        // fails only for the posts that happen to carry video.
        restrictions.push(scopeRestriction('publishing.video', [SCOPE_PUBLISH_VIDEO]));
      }

      if (!hasScopes(granted, [SCOPE_READ_ENGAGEMENT])) {
        restrictions.push(scopeRestriction('actions.comments_read', [SCOPE_READ_ENGAGEMENT]));
      }
      if (!hasScopes(granted, [SCOPE_MANAGE_ENGAGEMENT])) {
        restrictions.push(scopeRestriction('actions.comments_reply', [SCOPE_MANAGE_ENGAGEMENT]));
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? input.requestedScopes : DEFAULT_SCOPES;

        return buildAuthorizationUrl({
          app,
          state: input.state,
          scopes,
          rerequest: input.options.rerequest === true,
        });
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        // Meta reports a declined consent in the query string with a 200, so it has to be
        // read explicitly rather than left to an HTTP status check.
        if (input.query.error) {
          throw new GraphError(
            400,
            {
              message:
                input.query.error_description ??
                'The Facebook permission request was declined.',
              code: 190,
            },
            '',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new GraphError(400, { message: 'Facebook did not return an authorization code.' }, '');
        }

        // Exchanges for the long-lived token in the same step. Storing the callback's
        // short-lived token would leave every connection broken about an hour later.
        const token = await exchangeCodeForLongLivedToken(input.context, { app, code });

        const pages = await listManagedPages(input.context, {
          app,
          accessToken: token.accessToken,
        });

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.accessToken,
            externalAccountId: token.userId,
            ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
            grantedScopes: token.grantedScopes,
            metadata: { pageCount: pages.length },
          },
          identity: {
            externalAccountId: token.userId,
            // The user token identifies a person, but what the customer manages is a set
            // of Pages, so the count is the useful thing to show in the connection list.
            displayName: pages.length === 1 ? (pages[0]?.name ?? 'Facebook') : `Facebook (${pages.length} Pages)`,
            handle: null,
            avatarUrl: pages[0]?.pictureUrl ?? null,
            accountType: 'user',
            grantedScopes: token.grantedScopes,
          },
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Facebook');

        // Meta has no refresh-token grant. A long-lived user token can be re-exchanged for
        // a fresh 60-day window while it is still valid, which is the closest thing
        // available — and it only works *before* expiry, so the proactive refresh sweep
        // matters more here than for a provider with real refresh tokens.
        const token = await exchangeForLongLivedToken(input.context, { app, accessToken });

        return {
          credentials: {
            ...input.credentials,
            accessToken: token.accessToken,
            ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
            grantedScopes: token.grantedScopes,
          },
          rotated: true,
        };
      },

      async revoke(input) {
        const app = requireApp(input.app);
        await revokePermissions(input.context, {
          app,
          accessToken: requireAccessToken(input.credentials, 'Facebook'),
        });
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Facebook');

        const inspected = await inspectToken(input.context, { app, accessToken });
        if (!inspected.valid) {
          throw new GraphError(
            401,
            { code: 190, message: 'This Facebook connection is no longer valid and must be reconnected.' },
            '',
          );
        }

        const pages = await listManagedPages(input.context, { app, accessToken });

        return {
          externalAccountId: inspected.userId,
          displayName: pages.length === 1 ? (pages[0]?.name ?? 'Facebook') : `Facebook (${pages.length} Pages)`,
          handle: null,
          avatarUrl: pages[0]?.pictureUrl ?? null,
          accountType: 'user',
          grantedScopes: inspected.grantedScopes,
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const app = requireApp(input.app);
        const pages = await listManagedPages(input.context, {
          app,
          accessToken: requireAccessToken(input.credentials, 'Facebook'),
        });

        return pages.map((page) => ({
          externalId: page.id,
          displayName: page.name,
          handle: null,
          avatarUrl: page.pictureUrl,
          kind: 'page',
          // The Page token travels with the destination and is encrypted exactly like a
          // connection credential. This is why `ProviderDestination` carries credentials
          // at all: a Meta Page token is not the token that discovered the Page.
          credentials: {
            strategy: 'oauth2',
            accessToken: page.accessToken,
            externalAccountId: page.id,
            grantedScopes: input.credentials.grantedScopes,
            metadata: {},
          },
          metadata: {
            category: page.category,
            tasks: page.tasks,
            // Surfaced so the dashboard can explain why a Page the user can see cannot be
            // posted to: an Analyst role administers the Page but cannot create content.
            canPublish: page.tasks.includes(TASK_CREATE_CONTENT),
            ...(page.instagram ? { instagramAccountId: page.instagram.id } : {}),
          },
        }));
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_MESSAGE, { code: 'TEXT_TOO_LONG', truncatable: true }),
            f.checkMediaCount(content.media.length, MAX_PHOTOS),
          ),
        );

        if (content.text.trim() === '' && content.media.length === 0 && !content.linkUrl) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Facebook post needs a message, a link or media.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        const videos = content.media.filter((item) => item.kind === 'video');
        if (videos.length > 1) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', 'A Facebook post carries at most one video.', {
              field: 'media',
              agentAction: 'remove_media',
            }),
          );
        }
        if (videos.length > 0 && content.media.length > videos.length) {
          // `/videos` and `/photos` are different endpoints producing different post types,
          // and there is no documented way to combine them in one Page post.
          results.push(
            f.error('MEDIA_MIXED_TYPES_UNSUPPORTED', 'Facebook cannot mix video and images in one post.', {
              field: 'media',
              agentAction: 'split_into_separate_posts',
            }),
          );
        }

        content.media.forEach((item, index) => {
          const supported = item.kind === 'video' ? SUPPORTED_VIDEO_TYPES : SUPPORTED_IMAGE_TYPES;
          results.push(...f.collect(f.checkMediaType(item.mimeType, supported, index)));
        });

        if (content.linkUrl && content.media.length > 0) {
          // Facebook renders the photo and drops the link card. The link still appears if
          // it is in the message text, so this is a warning rather than an error.
          results.push(
            f.warning('LINK_PREVIEW_SUPPRESSED', 'Facebook shows the media instead of a link preview when both are present.', {
              field: 'content.linkUrl',
              agentAction: 'put_the_url_in_the_message_text',
            }),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const app = requireApp(input.app);
        const pageToken = pageTokenOf(input.credentials);
        const pageId = input.target.destinationExternalId;

        const images = input.content.media.filter((item) => item.kind === 'image');

        // A single photo is published in one call by `publish`, so there is nothing to
        // prepare. Uploading it here would create an unpublished photo that publish then
        // has to attach — more calls, more state, no benefit.
        if (images.length <= 1) return { state: {}, providerMediaIds: [] };

        // Several photos: each is uploaded unpublished, and `publish` attaches the
        // resulting ids to one feed post. `published=false` is what keeps these off the
        // Page — an unpublished photo is invisible until it is attached.
        const mediaFbids: string[] = [];

        for (const image of images) {
          const { data } = await graphCall<{ id?: string }>(input.context, {
            method: 'POST',
            path: `/${pageId}/photos`,
            operation: 'uploadUnpublishedPhoto',
            accessToken: pageToken,
            appSecret: app.clientSecret,
            form: {
              url: image.downloadUrl,
              published: 'false',
              ...(image.altText ? { alt_text_custom: image.altText } : {}),
            },
            timeoutMs: 120_000,
          });

          if (!data.id) {
            throw new GraphError(502, { message: 'Facebook accepted the photo but returned no id.' }, '');
          }
          mediaFbids.push(data.id);
        }

        return { state: { mediaFbids }, providerMediaIds: mediaFbids };
      },

      async publish(input) {
        const app = requireApp(input.app);
        const pageToken = pageTokenOf(input.credentials);
        const pageId = input.target.destinationExternalId;
        const message = input.content.text;

        const images = input.content.media.filter((item) => item.kind === 'image');
        const video = input.content.media.find((item) => item.kind === 'video');
        const mediaFbids = (input.prepared.state.mediaFbids as string[] | undefined) ?? [];

        let postId: string;

        if (video) {
          // The video endpoint returns the *video* id, and Facebook also returns the
          // resulting post id. Preferring `post_id` matters: deleting or reading back a
          // video id is not the same operation as doing it to the post.
          const { data } = await graphCall<{ id?: string; post_id?: string }>(input.context, {
            method: 'POST',
            path: `/${pageId}/videos`,
            operation: 'publishVideo',
            accessToken: pageToken,
            appSecret: app.clientSecret,
            form: {
              file_url: video.downloadUrl,
              ...(message ? { description: message } : {}),
            },
            timeoutMs: 300_000,
          });

          postId = data.post_id ?? data.id ?? '';
        } else if (mediaFbids.length > 0) {
          // Multi-photo. `attached_media` is an indexed form field, one per photo.
          const attachments: Record<string, string> = {};
          mediaFbids.forEach((id, index) => {
            attachments[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
          });

          const { data } = await graphCall<{ id?: string }>(input.context, {
            method: 'POST',
            path: `/${pageId}/feed`,
            operation: 'publishMultiPhoto',
            accessToken: pageToken,
            appSecret: app.clientSecret,
            form: { ...(message ? { message } : {}), ...attachments },
          });

          postId = data.id ?? '';
        } else if (images.length === 1 && images[0]) {
          const { data } = await graphCall<{ id?: string; post_id?: string }>(input.context, {
            method: 'POST',
            path: `/${pageId}/photos`,
            operation: 'publishPhoto',
            accessToken: pageToken,
            appSecret: app.clientSecret,
            form: {
              url: images[0].downloadUrl,
              ...(message ? { caption: message } : {}),
              ...(images[0].altText ? { alt_text_custom: images[0].altText } : {}),
            },
            timeoutMs: 120_000,
          });

          postId = data.post_id ?? data.id ?? '';
        } else {
          const { data } = await graphCall<{ id?: string }>(input.context, {
            method: 'POST',
            path: `/${pageId}/feed`,
            operation: 'publishFeed',
            accessToken: pageToken,
            appSecret: app.clientSecret,
            form: {
              ...(message ? { message } : {}),
              ...(input.content.linkUrl ? { link: input.content.linkUrl } : {}),
            },
          });

          postId = data.id ?? '';
        }

        if (!postId) {
          // Rule 14 — a 200 with no id means we cannot say what was created. Treated as a
          // failure so reconciliation runs, rather than recording an empty id that would
          // make the post unreadable and undeletable forever.
          throw new GraphError(502, { message: 'Facebook accepted the post but returned no id.' }, '');
        }

        return {
          outcome: 'published',
          externalPostId: postId,
          // Page post ids are `{page-id}_{post-id}`, and this permalink form works for both.
          externalUrl: `https://www.facebook.com/${postId.replace('_', '/posts/')}`,
          publishedAt: new Date().toISOString(),
          metadata: { pageId },
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4, and the reason error 506 is mapped to POSSIBLE_DUPLICATE rather
        // than to a content rejection: Facebook refusing a duplicate is evidence that
        // something published, and this is what turns that evidence into an answer.
        const app = requireApp(input.app);
        const pageId = input.target.destinationExternalId;
        const limit = 50;

        const { data } = await graphCall<{ data?: FeedPost[] }>(input.context, {
          method: 'GET',
          path: `/${pageId}/feed`,
          operation: 'findPossibleDuplicate',
          accessToken: pageTokenOf(input.credentials),
          appSecret: app.clientSecret,
          query: { fields: 'id,message,created_time', limit: String(limit) },
        });

        const posts = data.data ?? [];
        const attemptedAfter = Date.parse(input.attemptedAfter);
        const wanted = input.content.text.trim();

        for (const post of posts) {
          const createdAt = post.created_time ? Date.parse(post.created_time) : NaN;
          // A post from before the attempt cannot be the one we are looking for. Without
          // this, an identical post from last week would be adopted as this one's result.
          if (Number.isFinite(createdAt) && createdAt < attemptedAfter) continue;
          if ((post.message ?? '').trim() !== wanted) continue;

          return {
            conclusion: 'found',
            externalPostId: post.id,
            externalUrl: `https://www.facebook.com/${post.id.replace('_', '/posts/')}`,
            ...(post.created_time ? { publishedAt: new Date(post.created_time).toISOString() } : {}),
          };
        }

        // The feed is a page, not the whole history. A full page means an older match could
        // sit just outside it, so absence is not provable (Rule 14).
        if (posts.length >= limit) {
          return {
            conclusion: 'indeterminate',
            reason: 'The Page feed page was full, so an earlier matching post cannot be ruled out.',
          };
        }

        // A media-only post carries no message to match on, so an empty-text comparison
        // would match every photo the Page has ever posted.
        if (wanted === '' && input.content.media.length > 0) {
          return {
            conclusion: 'indeterminate',
            reason: 'This post has no text, so a matching post cannot be identified from the feed alone.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        const app = requireApp(input.app);

        try {
          await graphCall(input.context, {
            method: 'DELETE',
            path: `/${input.externalPostId}`,
            operation: 'deletePost',
            accessToken: pageTokenOf(input.credentials),
            appSecret: app.clientSecret,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          // Subcode 33 is Meta's "this object does not exist, or you cannot see it", which
          // is what a second delete looks like. P4 requires deleting twice to be safe.
          if (error instanceof GraphError && (error.status === 404 || error.subcode === 33)) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      const shared = normalizeGraphError(error, 'Facebook', context.operation);
      if (shared) return shared;

      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401 || status === 403) {
          return { code: 'AUTH_EXPIRED', message: 'Facebook rejected the credentials.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Facebook returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Facebook failure during ${context.operation}.`,
      };
    },

    /**
     * Page webhooks (plan §34). `page` is the Meta webhook object for a Facebook Page,
     * which is what distinguishes a Page comment from the identical Instagram payload.
     */
    verifyWebhook(request) {
      return handleMetaWebhook(request, 'page');
    },
  };
}

/** Re-exported so callers can catch a Graph failure without importing the core package. */
export { GraphError as FacebookError, GRAPH_HOST as FACEBOOK_GRAPH_HOST };
