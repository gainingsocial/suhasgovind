import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  accountTypeRestriction,
  buildCapabilities,
  findings as f,
  hasScopes,
  restrictCapabilities,
  scopeRestriction,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderAppCredentials,
  type ProviderDestination,
  type ResolvedMedia,
  type SocialProviderAdapter,
} from '@gs/provider-kit';
import {
  buildAuthorizationUrl,
  ContainerNotReadyError,
  exchangeCodeForLongLivedToken,
  exchangeForLongLivedToken,
  GraphError,
  graphCall,
  inspectToken,
  listManagedPages,
  normalizeGraphError,
  readContainerStatus,
  requireAccessToken,
  revokePermissions,
  waitForContainer,
  GRAPH_HOST,
} from '@gs/provider-meta-core';

/**
 * Instagram adapter (Content Publishing API).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.facebook.com/docs/instagram-platform/content-publishing
 *   https://developers.facebook.com/docs/instagram-platform/instagram-graph-api
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *
 * Four documented facts that an adapter written from intuition would get wrong.
 *
 *   **Instagram pulls the media; we never upload bytes.** Every other platform here takes
 *   an upload. Instagram takes a URL and fetches it itself, which means the media must be
 *   reachable from Meta's servers for as long as the fetch takes. Our short-lived signed R2
 *   URLs satisfy that, but only because they are signed rather than authenticated — a
 *   header-authenticated URL would fail with an error about an unsupported format.
 *
 *   **JPEG only.** Not "JPEG preferred". A PNG is rejected, and the error names the format
 *   rather than saying what to do about it, so this is caught in validation instead.
 *
 *   **Business or Creator accounts only, and only ones linked to a Facebook Page.** A
 *   personal Instagram account cannot publish through the API at all. This is the single
 *   most common reason a connection succeeds and then has no destinations.
 *
 *   **100 posts per rolling 24 hours, per account.** Meta exposes the current usage, so it
 *   is checked before publishing rather than discovered as a failure at post 101.
 *
 * There is deliberately no `delete`: the Content Publishing API does not offer one. Meta
 * documents publishing and reading; deletion of a published media object is not part of
 * the API, and pretending otherwise would put a working Delete button in the dashboard
 * that silently does nothing.
 */

export const ADAPTER_VERSION = '1.0.0';

/**
 * Caption limit, documented on the `caption` field of the media endpoint alongside the
 * hashtag and mention ceilings.
 */
const MAX_CAPTION = 2_200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;

/** Carousel bounds, both documented. A one-item carousel is rejected. */
const MIN_CAROUSEL = 2;
const MAX_CAROUSEL = 10;

/** Rolling-window publishing quota, per Instagram account. */
const DAILY_POST_QUOTA = 100;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;

/** Reels bounds. Anything longer or shorter is rejected at container creation. */
const MIN_REEL_SECONDS = 3;
const MAX_REEL_SECONDS = 900;

const SCOPE_BASIC = 'instagram_basic';
const SCOPE_PUBLISH = 'instagram_content_publish';
const SCOPE_PAGES_LIST = 'pages_show_list';
const SCOPE_PAGES_READ = 'pages_read_engagement';

const DEFAULT_SCOPES = [
  SCOPE_BASIC,
  SCOPE_PUBLISH,
  SCOPE_PAGES_LIST,
  SCOPE_PAGES_READ,
  'business_management',
] as const;

/**
 * How long to wait for Instagram to process a container before giving up.
 *
 * Images finish in seconds; a video transcode can take minutes. This runs inside `prepare`,
 * so exceeding it is safe — nothing has published, and the engine retries the whole
 * preparation with a fresh container.
 */
const IMAGE_PROCESSING_BUDGET_MS = 30_000;
const VIDEO_PROCESSING_BUDGET_MS = 300_000;

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    throw new GraphError(
      500,
      {
        message:
          'No Meta application is configured. Add its App ID and App Secret before connecting Instagram.',
      },
      '',
    );
  }
  return app;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'instagram',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      // Instagram has no text-only post. A caption exists only to accompany media, and a
      // post with no image or video cannot be created at all.
      text_only: false,
      image: true,
      video: true,
      carousel: true,
      story: true,
      reel: true,
      // No link preview: Instagram does not linkify caption text, so a URL in a caption is
      // plain text the reader has to copy out.
      link_preview: false,
    },
    actions: {
      // Deliberately false. The Content Publishing API has no delete endpoint, and
      // declaring it would put a button in the dashboard that cannot work.
      delete_post: false,
      comments_read: true,
      comments_reply: true,
    },
    constraints: {
      max_text_length: MAX_CAPTION,
      max_media_count: MAX_CAROUSEL,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      // Instagram takes alt text on a container but does not return it, so it is written
      // and never read back.
      supports_alt_text: true,
      allowed_privacy_levels: ['PUBLIC'],
      max_video_duration_seconds: MAX_REEL_SECONDS,
      min_video_duration_seconds: MIN_REEL_SECONDS,
    },
  });
}

type PostKind = 'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES' | 'CAROUSEL';

/**
 * Decide which of Instagram's five post types this content is.
 *
 * Instagram does not infer it. `media_type` is an explicit parameter, and picking the wrong
 * one produces a post in the wrong place — a Reel filed as a video, or a permanent post
 * where a 24-hour Story was intended.
 */
function resolvePostKind(
  media: readonly ResolvedMedia[],
  providerOptions: Readonly<Record<string, unknown>>,
): PostKind {
  const requested = providerOptions.postType;
  if (requested === 'STORIES' || requested === 'REELS') return requested;

  if (media.length > 1) return 'CAROUSEL';
  // A single video is published as a Reel. Since 2024 Instagram files every standalone
  // feed video as a Reel regardless, so choosing REELS here matches where the post
  // actually lands rather than where the parameter name suggests.
  if (media[0]?.kind === 'video') return 'REELS';
  return 'IMAGE';
}

function countHashtags(text: string): number {
  return (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

function countMentions(text: string): number {
  return (text.match(/@[\w.]+/g) ?? []).length;
}

interface IgAccount {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  followers_count?: number;
}

interface IgMedia {
  id: string;
  caption?: string;
  timestamp?: string;
  permalink?: string;
}

export function createInstagramAdapter(): SocialProviderAdapter {
  return {
    provider: 'instagram',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [SCOPE_PUBLISH])) {
        for (const capability of ['image', 'video', 'carousel', 'story', 'reel']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_PUBLISH]));
        }
      }

      if (!hasScopes(granted, [SCOPE_BASIC])) {
        restrictions.push(scopeRestriction('actions.comments_read', [SCOPE_BASIC]));
      }

      // A personal account can complete the whole OAuth flow and then publish nothing.
      // Saying so as a capability restriction — with the account type named — is the
      // difference between a five-minute fix and a support ticket.
      const accountType = context.accountType;
      if (accountType !== null && accountType !== undefined && accountType !== 'BUSINESS' && accountType !== 'CREATOR') {
        for (const capability of ['image', 'video', 'carousel', 'story', 'reel']) {
          restrictions.push(accountTypeRestriction(`publishing.${capability}`, 'Business or Creator', accountType));
        }
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        // Instagram professional accounts authorize through Facebook Login, because the
        // account is reached via the Page it is linked to. There is no separate Instagram
        // consent screen for this flow.
        return buildAuthorizationUrl({
          app,
          state: input.state,
          scopes: input.requestedScopes.length > 0 ? input.requestedScopes : DEFAULT_SCOPES,
          rerequest: input.options.rerequest === true,
        });
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new GraphError(
            400,
            {
              code: 190,
              message: input.query.error_description ?? 'The Instagram permission request was declined.',
            },
            '',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new GraphError(400, { message: 'Meta did not return an authorization code.' }, '');
        }

        const token = await exchangeCodeForLongLivedToken(input.context, { app, code });
        const pages = await listManagedPages(input.context, { app, accessToken: token.accessToken });
        const linked = pages.filter((page) => page.instagram !== null);

        if (linked.length === 0) {
          // Rule 14 — fail at connect time with the actual remedy, rather than succeeding
          // into a connection that can never publish. This is the most common Instagram
          // setup problem by a wide margin.
          throw new GraphError(
            400,
            {
              code: 100,
              message:
                'No Instagram professional account is linked to a Facebook Page on this login. ' +
                'Instagram publishing requires a Business or Creator account linked to a Page you administer.',
            },
            '',
          );
        }

        const first = linked[0]?.instagram;

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: token.accessToken,
            externalAccountId: token.userId,
            ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
            grantedScopes: token.grantedScopes,
            metadata: { instagramAccountCount: linked.length },
          },
          identity: {
            externalAccountId: token.userId,
            displayName: first?.username ? `@${first.username}` : 'Instagram',
            handle: first?.username ?? null,
            avatarUrl: first?.pictureUrl ?? null,
            accountType: 'BUSINESS',
            grantedScopes: token.grantedScopes,
          },
        };
      },

      async refresh(input) {
        const app = requireApp(input.app);
        const token = await exchangeForLongLivedToken(input.context, {
          app,
          accessToken: requireAccessToken(input.credentials, 'Instagram'),
        });

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
        await revokePermissions(input.context, {
          app: requireApp(input.app),
          accessToken: requireAccessToken(input.credentials, 'Instagram'),
        });
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Instagram');

        const inspected = await inspectToken(input.context, { app, accessToken });
        if (!inspected.valid) {
          throw new GraphError(
            401,
            { code: 190, message: 'This Instagram connection is no longer valid and must be reconnected.' },
            '',
          );
        }

        const pages = await listManagedPages(input.context, { app, accessToken });
        const first = pages.find((page) => page.instagram !== null)?.instagram;

        return {
          externalAccountId: inspected.userId,
          displayName: first?.username ? `@${first.username}` : 'Instagram',
          handle: first?.username ?? null,
          avatarUrl: first?.pictureUrl ?? null,
          accountType: 'BUSINESS',
          grantedScopes: inspected.grantedScopes,
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Instagram');
        const pages = await listManagedPages(input.context, { app, accessToken });

        const destinations: ProviderDestination[] = [];

        for (const page of pages) {
          if (!page.instagram) continue;

          // Enrich with the account's own profile. Worth the extra call: the linked-account
          // expansion gives an id and a username, and the dashboard wants a follower count
          // and a display name so a customer with several accounts can tell them apart.
          let account: IgAccount = { id: page.instagram.id };
          try {
            const { data } = await graphCall<IgAccount>(input.context, {
              method: 'GET',
              path: `/${page.instagram.id}`,
              operation: 'readInstagramAccount',
              query: { fields: 'id,username,name,profile_picture_url,followers_count' },
              accessToken: page.accessToken,
              appSecret: app.clientSecret,
            });
            account = data;
          } catch {
            // A profile read that fails must not lose a publishable destination.
          }

          destinations.push({
            externalId: page.instagram.id,
            displayName: account.name ?? (account.username ? `@${account.username}` : 'Instagram'),
            handle: account.username ?? page.instagram.username,
            avatarUrl: account.profile_picture_url ?? page.instagram.pictureUrl,
            kind: 'instagram_account',
            // Publishing uses the *Page* token, not the user token — the Instagram account
            // is administered through its Page.
            credentials: {
              strategy: 'oauth2',
              accessToken: page.accessToken,
              externalAccountId: page.instagram.id,
              grantedScopes: input.credentials.grantedScopes,
              metadata: { pageId: page.id },
            },
            metadata: {
              pageId: page.id,
              pageName: page.name,
              ...(account.followers_count !== undefined ? { followersCount: account.followers_count } : {}),
            },
          });
        }

        return destinations;
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const kind = resolvePostKind(content.media, content.providerOptions);

        results.push(
          ...f.collect(f.checkTextLength(content.text, MAX_CAPTION, { code: 'TEXT_TOO_LONG', truncatable: true })),
        );

        if (content.media.length === 0) {
          // The defining constraint of the platform. Caught here so a fan-out that includes
          // Instagram alongside text-capable networks fails preflight with a clear reason
          // rather than failing only on Instagram at publish time.
          results.push(
            f.error('MEDIA_REQUIRED', 'Instagram has no text-only post; every post needs an image or a video.', {
              field: 'media',
              agentAction: 'add_media_or_remove_this_destination',
            }),
          );
        }

        if (kind === 'CAROUSEL' && content.media.length > MAX_CAROUSEL) {
          results.push(...f.collect(f.checkMediaCount(content.media.length, MAX_CAROUSEL)));
        }
        if (content.media.length > 1 && content.media.length < MIN_CAROUSEL) {
          results.push(
            f.error('TOO_FEW_MEDIA_ITEMS', `An Instagram carousel needs at least ${MIN_CAROUSEL} items.`, {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }

        const hashtags = countHashtags(content.text);
        if (hashtags > MAX_HASHTAGS) {
          results.push(
            f.error('TOO_MANY_HASHTAGS', `${hashtags} hashtags in the caption; Instagram allows ${MAX_HASHTAGS}.`, {
              field: 'content.text',
              agentAction: 'remove_hashtags',
            }),
          );
        }

        const mentions = countMentions(content.text);
        if (mentions > MAX_MENTIONS) {
          results.push(
            f.error('TOO_MANY_MENTIONS', `${mentions} mentions in the caption; Instagram allows ${MAX_MENTIONS}.`, {
              field: 'content.text',
              agentAction: 'remove_mentions',
            }),
          );
        }

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            results.push(
              ...f.collect(
                f.checkMediaType(item.mimeType, SUPPORTED_VIDEO_TYPES, index),
                f.checkVideoDuration(item.durationSeconds, { min: MIN_REEL_SECONDS, max: MAX_REEL_SECONDS }, index),
              ),
            );
          } else {
            // JPEG only, and this is why validation is worth having: Instagram's own error
            // for a PNG names the format without saying it is unsupported everywhere.
            results.push(...f.collect(f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index)));
          }
        });

        if (content.linkUrl) {
          results.push(
            f.warning('LINK_NOT_CLICKABLE', 'Instagram does not linkify captions, so this URL will appear as plain text.', {
              field: 'content.linkUrl',
              agentAction: 'use_the_profile_link_instead',
            }),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Instagram');
        const igUserId = input.target.destinationExternalId;
        const kind = resolvePostKind(input.content.media, input.content.providerOptions);
        const hasVideo = input.content.media.some((item) => item.kind === 'video');

        // Check the rolling quota before doing any work. Meta exposes it, so hitting the
        // limit is a choice rather than a surprise — and a container built against an
        // exhausted quota is wasted transcoding.
        try {
          const { data } = await graphCall<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
            input.context,
            {
              method: 'GET',
              path: `/${igUserId}/content_publishing_limit`,
              operation: 'readPublishingLimit',
              query: { fields: 'config,quota_usage' },
              accessToken,
              appSecret: app.clientSecret,
            },
          );

          const usage = data.data?.[0];
          const used = usage?.quota_usage ?? 0;
          const total = usage?.config?.quota_total ?? DAILY_POST_QUOTA;

          if (used >= total) {
            throw new GraphError(
              429,
              {
                code: 4,
                message: `This Instagram account has published ${used} of ${total} posts allowed in a rolling 24 hours.`,
              },
              '',
            );
          }
        } catch (error) {
          // Only the quota verdict is fatal. If the limit endpoint itself is unavailable,
          // publishing should not be blocked by a failed precaution.
          if (error instanceof GraphError && error.status === 429) throw error;
        }

        const containers: string[] = [];

        if (kind === 'CAROUSEL') {
          // Each item gets its own container marked `is_carousel_item`, then a parent
          // container references them all by id.
          for (const media of input.content.media) {
            const id = await createContainer(input.context, {
              igUserId,
              accessToken,
              appSecret: app.clientSecret,
              form: {
                ...(media.kind === 'video'
                  ? { media_type: 'VIDEO', video_url: media.downloadUrl }
                  : { image_url: media.downloadUrl }),
                is_carousel_item: 'true',
                ...(media.altText ? { alt_text: media.altText } : {}),
              },
            });
            containers.push(id);
          }

          // Children must finish processing before the parent can reference them.
          for (const child of containers) {
            await waitForContainer(
              input.context,
              { host: GRAPH_HOST, statusField: 'status_code', accessToken, appSecret: app.clientSecret, containerId: child },
              { budgetMs: hasVideo ? VIDEO_PROCESSING_BUDGET_MS : IMAGE_PROCESSING_BUDGET_MS },
            );
          }

          const parent = await createContainer(input.context, {
            igUserId,
            accessToken,
            appSecret: app.clientSecret,
            form: {
              media_type: 'CAROUSEL',
              children: containers.join(','),
              ...(input.content.text ? { caption: input.content.text } : {}),
            },
          });

          await waitForContainer(
            input.context,
            { host: GRAPH_HOST, statusField: 'status_code', accessToken, appSecret: app.clientSecret, containerId: parent },
            { budgetMs: IMAGE_PROCESSING_BUDGET_MS },
          );

          return { state: { containerId: parent, kind }, providerMediaIds: [...containers, parent] };
        }

        const media = input.content.media[0];
        if (!media) {
          throw new GraphError(400, { code: 100, message: 'Instagram requires an image or a video.' }, '');
        }

        const containerId = await createContainer(input.context, {
          igUserId,
          accessToken,
          appSecret: app.clientSecret,
          form: {
            ...(kind === 'IMAGE' ? { image_url: media.downloadUrl } : { media_type: kind, video_url: media.downloadUrl }),
            // A Story carries no caption; sending one is rejected rather than ignored.
            ...(kind !== 'STORIES' && input.content.text ? { caption: input.content.text } : {}),
            ...(media.altText && kind === 'IMAGE' ? { alt_text: media.altText } : {}),
          },
        });

        await waitForContainer(
          input.context,
          { host: GRAPH_HOST, statusField: 'status_code', accessToken, appSecret: app.clientSecret, containerId },
          { budgetMs: media.kind === 'video' ? VIDEO_PROCESSING_BUDGET_MS : IMAGE_PROCESSING_BUDGET_MS },
        );

        return { state: { containerId, kind }, providerMediaIds: [containerId] };
      },

      async publish(input) {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Instagram');
        const igUserId = input.target.destinationExternalId;
        const containerId = input.prepared.state.containerId as string | undefined;

        if (!containerId) {
          throw new GraphError(500, { message: 'No Instagram media container was prepared for this post.' }, '');
        }

        // The single irreversible call. Everything expensive already happened in `prepare`,
        // which is what keeps the window for an ambiguous failure as narrow as possible.
        const { data } = await graphCall<{ id?: string }>(input.context, {
          method: 'POST',
          path: `/${igUserId}/media_publish`,
          operation: 'mediaPublish',
          accessToken,
          appSecret: app.clientSecret,
          form: { creation_id: containerId },
        });

        if (!data.id) {
          throw new GraphError(502, { message: 'Instagram accepted the publish but returned no media id.' }, '');
        }

        let permalink: string | null = null;
        try {
          const { data: media } = await graphCall<IgMedia>(input.context, {
            method: 'GET',
            path: `/${data.id}`,
            operation: 'readPermalink',
            query: { fields: 'permalink' },
            accessToken,
            appSecret: app.clientSecret,
          });
          permalink = media.permalink ?? null;
        } catch {
          // The post is already live. A missing permalink is cosmetic and must not turn a
          // successful publish into a failure that gets retried.
        }

        return {
          outcome: 'published',
          externalPostId: data.id,
          externalUrl: permalink,
          publishedAt: new Date().toISOString(),
          metadata: { containerId, kind: input.prepared.state.kind },
        };
      },

      async findPossibleDuplicate(input) {
        const app = requireApp(input.app);
        const accessToken = requireAccessToken(input.credentials, 'Instagram');
        // The parent container is the last id `prepare` recorded — carousel children come
        // first, and only the parent is ever published.
        const containerId = input.providerMediaIds.at(-1);

        // The container gives a far better answer than any text search. It is a specific
        // object whose state Instagram maintains, so its status is evidence rather than
        // inference; matching captions cannot tell this post apart from an identical one
        // the customer published deliberately an hour ago.
        if (containerId) {
          try {
            const state = await readContainerStatus(input.context, {
              host: GRAPH_HOST,
              statusField: 'status_code',
              accessToken,
              appSecret: app.clientSecret,
              containerId,
            });

            // FINISHED means processed and never published — provable absence, which makes
            // the retry safe. IN_PROGRESS means it never even got that far.
            if (state.status === 'FINISHED' || state.status === 'IN_PROGRESS') {
              return { conclusion: 'absent' };
            }
            // PUBLISHED confirms a post exists; the search below finds which one. EXPIRED
            // is ambiguous — the container is gone and took the answer with it — so it
            // also falls through rather than being read either way.
          } catch {
            // A container lookup that fails must not lose the fallback search.
          }
        }

        const limit = 25;
        const { data } = await graphCall<{ data?: IgMedia[] }>(input.context, {
          method: 'GET',
          path: `/${input.target.destinationExternalId}/media`,
          operation: 'findPossibleDuplicate',
          query: { fields: 'id,caption,timestamp,permalink', limit: String(limit) },
          accessToken,
          appSecret: app.clientSecret,
        });

        const items = data.data ?? [];
        const attemptedAfter = Date.parse(input.attemptedAfter);
        const wanted = input.content.text.trim();

        for (const item of items) {
          const createdAt = item.timestamp ? Date.parse(item.timestamp) : NaN;
          if (Number.isFinite(createdAt) && createdAt < attemptedAfter) continue;
          if ((item.caption ?? '').trim() !== wanted) continue;

          return {
            conclusion: 'found',
            externalPostId: item.id,
            ...(item.permalink ? { externalUrl: item.permalink } : {}),
            ...(item.timestamp ? { publishedAt: new Date(item.timestamp).toISOString() } : {}),
          };
        }

        if (wanted === '') {
          // Every Instagram post has media and many have no caption, so an empty-caption
          // match would adopt an unrelated post. Rule 14: say so rather than guess.
          return {
            conclusion: 'indeterminate',
            reason: 'This post has no caption, so a matching post cannot be identified from recent media alone.',
          };
        }

        if (items.length >= limit) {
          return {
            conclusion: 'indeterminate',
            reason: 'The recent media page was full, so an earlier matching post cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ContainerNotReadyError) {
        // Raised only from `prepare`, where nothing has published. Safe to retry, and the
        // media pipeline code says exactly which stage was slow.
        return {
          code: 'MEDIA_PROCESSING_FAILED',
          message: error.message,
        };
      }

      const shared = normalizeGraphError(error, 'Instagram', context.operation);
      if (shared) return shared;

      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401 || status === 403) {
          return { code: 'AUTH_EXPIRED', message: 'Instagram rejected the credentials.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Instagram returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Instagram failure during ${context.operation}.`,
      };
    },
  };
}

async function createContainer(
  context: Parameters<typeof graphCall>[0],
  input: {
    igUserId: string;
    accessToken: string;
    appSecret: string;
    form: Record<string, string | undefined>;
  },
): Promise<string> {
  const { data } = await graphCall<{ id?: string }>(context, {
    method: 'POST',
    path: `/${input.igUserId}/media`,
    operation: 'createContainer',
    accessToken: input.accessToken,
    appSecret: input.appSecret,
    form: input.form,
    // Instagram fetches the media itself, so this call is as slow as the download.
    timeoutMs: 120_000,
  });

  if (!data.id) {
    throw new GraphError(502, { message: 'Instagram did not return a media container id.' }, '');
  }
  return data.id;
}

export { GraphError as InstagramError };
