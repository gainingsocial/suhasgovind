import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildCapabilities,
  findings as f,
  hasScopes,
  providerFetch,
  restrictCapabilities,
  scopeRestriction,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderAppCredentials,
  type ProviderCallContext,
  type ProviderDestination,
  type SocialProviderAdapter,
} from '@gs/provider-kit';
import {
  ContainerNotReadyError,
  GraphError,
  graphCall,
  normalizeGraphError,
  readContainerStatus,
  requireAccessToken,
  THREADS_HOST,
  waitForContainer,
} from '@gs/provider-meta-core';

/**
 * Threads adapter.
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.facebook.com/docs/threads/create-posts
 *   https://developers.facebook.com/docs/threads/posts
 *   https://developers.facebook.com/docs/threads/get-started
 *
 * Threads is a Meta platform but not a Meta *Graph* integration in the way Facebook and
 * Instagram are, and the differences are the ones most likely to be assumed away:
 *
 *   **Its own host and its own application.** `graph.threads.net`, registered separately
 *   from the Facebook app, with its own client id and secret. A Threads credential pasted
 *   into the Meta app slot will authenticate against nothing.
 *
 *   **No `appsecret_proof`.** Threads does not implement it, and sending one is rejected
 *   rather than ignored — so this adapter passes no app secret to the shared client, which
 *   is the one place it deliberately diverges from its siblings.
 *
 *   **Its own token grammar.** `th_exchange_token` and `th_refresh_token`, not
 *   `fb_exchange_token`. Same shape, different grant names, and the Facebook helpers in
 *   `@gs/provider-meta-core` do not apply.
 *
 *   **500 characters.** A quarter of Instagram's caption, and the constraint most likely
 *   to break a fan-out that composed one message for every network.
 *
 * What it does share is the container model, and that is the part worth sharing: create a
 * container, then publish it. Meta's own guidance is to wait roughly 30 seconds before
 * publishing, which lands entirely inside `prepare` here — so the wait costs nothing that
 * matters and the irreversible call stays a single short request.
 */

export const ADAPTER_VERSION = '1.0.0';

/** Documented, and low enough that a shared caption will routinely exceed it. */
const MAX_TEXT = 500;

/** Documented carousel bounds. A single-item carousel is rejected. */
const MIN_CAROUSEL = 2;
const MAX_CAROUSEL = 20;

/** Documented rolling-window quota, per profile. */
const DAILY_POST_QUOTA = 250;

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;

const SCOPE_BASIC = 'threads_basic';
const SCOPE_PUBLISH = 'threads_content_publish';
const SCOPE_REPLIES = 'threads_manage_replies';
const SCOPE_READ_REPLIES = 'threads_read_replies';

const DEFAULT_SCOPES = [SCOPE_BASIC, SCOPE_PUBLISH, SCOPE_READ_REPLIES, SCOPE_REPLIES] as const;

/**
 * Meta documents an average of ~30 seconds before a container is ready to publish.
 *
 * Spent inside `prepare`, where waiting is free: nothing has published, so exceeding the
 * budget is a safe retry rather than a decision about duplicate risk. A text-only post is
 * usually ready immediately, which is why the budget differs by media.
 */
const TEXT_PROCESSING_BUDGET_MS = 20_000;
const MEDIA_PROCESSING_BUDGET_MS = 240_000;

function requireApp(app: ProviderAppCredentials | null): ProviderAppCredentials {
  if (!app) {
    // Rule 14 — and worth being specific, because the most likely cause is a Facebook app
    // pasted into the Threads slot rather than a missing configuration.
    throw new GraphError(
      500,
      {
        message:
          'No Threads application is configured. Threads uses its own app registration, ' +
          'separate from the Meta app used for Facebook and Instagram.',
      },
      '',
    );
  }
  return app;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'threads',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      carousel: true,
      // Threads renders a preview for a URL in the text. There is no separate link field,
      // so the URL simply goes in the body — see validate().
      link_preview: true,
      // Threading, via reply_to_id — a chain of posts under one parent.
      thread: true,
    },
    actions: {
      delete_post: true,
      comments_read: true,
      comments_reply: true,
    },
    constraints: {
      max_text_length: MAX_TEXT,
      max_media_count: MAX_CAROUSEL,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      supports_alt_text: true,
      allowed_privacy_levels: ['PUBLIC'],
    },
  });
}

/**
 * Threads calls without an `appsecret_proof`.
 *
 * Every call in this file goes through here rather than through `graphCall` directly, so
 * the omission is a single deliberate decision rather than something to remember at each
 * call site.
 */
function threadsCall<T>(
  context: ProviderCallContext,
  input: {
    accessToken: string;
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    operation: string;
    query?: Record<string, string | undefined>;
    form?: Record<string, string | undefined>;
    timeoutMs?: number;
  },
) {
  return graphCall<T>(context, { host: THREADS_HOST, ...input });
}

interface ThreadsUser {
  id?: string;
  username?: string;
  name?: string;
  threads_profile_picture_url?: string;
}

interface ThreadsPost {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
}

export function createThreadsAdapter(): SocialProviderAdapter {
  return {
    provider: 'threads',
    version: ADAPTER_VERSION,
    authStrategy: 'oauth2',
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      const granted = context.grantedScopes ?? [];
      const restrictions = [];

      if (!hasScopes(granted, [SCOPE_PUBLISH])) {
        for (const capability of ['text_only', 'image', 'video', 'carousel', 'link_preview', 'thread']) {
          restrictions.push(scopeRestriction(`publishing.${capability}`, [SCOPE_PUBLISH]));
        }
      }
      if (!hasScopes(granted, [SCOPE_READ_REPLIES])) {
        restrictions.push(scopeRestriction('actions.comments_read', [SCOPE_READ_REPLIES]));
      }
      if (!hasScopes(granted, [SCOPE_REPLIES])) {
        restrictions.push(scopeRestriction('actions.comments_reply', [SCOPE_REPLIES]));
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        const app = requireApp(input.app);
        const scopes = input.requestedScopes.length > 0 ? input.requestedScopes : DEFAULT_SCOPES;

        // threads.net, not facebook.com — a Threads user authorizes in Threads.
        const url = new URL('https://threads.net/oauth/authorize');
        url.searchParams.set('client_id', app.clientId);
        url.searchParams.set('redirect_uri', app.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('state', input.state);
        url.searchParams.set('scope', scopes.join(','));

        return { authorizationUrl: url.toString(), state: input.state };
      },

      async exchangeCallback(input) {
        const app = requireApp(input.app);

        if (input.query.error) {
          throw new GraphError(
            400,
            {
              code: 190,
              message: input.query.error_description ?? 'The Threads permission request was declined.',
            },
            '',
          );
        }

        const code = input.query.code;
        if (!code) {
          throw new GraphError(400, { message: 'Threads did not return an authorization code.' }, '');
        }

        // The code exchange is form-encoded POST, unlike the query-string GET Facebook
        // uses — so it does not go through the shared client.
        const tokenResponse = await providerFetch(input.context, `${THREADS_HOST}/oauth/access_token`, {
          operation: 'oauth.code_exchange',
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: app.clientId,
            client_secret: app.clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: app.redirectUri,
            code,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          const envelope = (tokenResponse.json ?? {}) as { error_message?: string };
          throw new GraphError(
            tokenResponse.status,
            { message: envelope.error_message ?? 'Could not exchange the Threads authorization code.' },
            '',
          );
        }

        const short = tokenResponse.json as { access_token?: string; user_id?: number | string };
        if (!short.access_token) {
          throw new GraphError(502, { message: 'Threads did not return an access token.' }, '');
        }

        // Same trap as Facebook: the callback token is short-lived. Storing it produces
        // connections that all break about an hour later.
        const long = await exchangeForLongLivedThreadsToken(input.context, {
          app,
          accessToken: short.access_token,
        });

        const { data: user } = await threadsCall<ThreadsUser>(input.context, {
          accessToken: long.accessToken,
          method: 'GET',
          path: '/me',
          operation: 'readProfile',
          query: { fields: 'id,username,name,threads_profile_picture_url' },
        });

        const userId = user.id ?? String(short.user_id ?? '');

        return {
          credentials: {
            strategy: 'oauth2',
            accessToken: long.accessToken,
            externalAccountId: userId,
            expiresAt: long.expiresAt,
            // Threads returns no scope list, so record what was requested. Marking every
            // capability as granted without evidence would be worse: an over-broad
            // capability document approves posts that then fail.
            grantedScopes: input.query.scope ? input.query.scope.split(',').filter(Boolean) : [...DEFAULT_SCOPES],
            metadata: {},
          },
          identity: {
            externalAccountId: userId,
            displayName: user.name ?? (user.username ? `@${user.username}` : 'Threads'),
            handle: user.username ?? null,
            avatarUrl: user.threads_profile_picture_url ?? null,
            accountType: null,
            grantedScopes: [...DEFAULT_SCOPES],
          },
        };
      },

      async refresh(input) {
        // No app credentials here, deliberately: the Threads refresh grant authenticates
        // with the token being refreshed and takes no client secret.
        const accessToken = requireAccessToken(input.credentials, 'Threads');

        // `th_refresh_token`, and only valid on a token that is at least 24 hours old and
        // not yet expired. Outside that window the user must reconnect — which is why the
        // proactive refresh sweep matters more here than for a provider with real refresh
        // tokens.
        const { data } = await threadsCall<{ access_token?: string; expires_in?: number }>(input.context, {
          accessToken,
          method: 'GET',
          path: '/refresh_access_token',
          operation: 'oauth.refresh',
          query: { grant_type: 'th_refresh_token' },
        });

        if (!data.access_token) {
          throw new GraphError(401, { code: 190, message: 'Threads did not return a refreshed token.' }, '');
        }

        return {
          credentials: {
            ...input.credentials,
            accessToken: data.access_token,
            ...(data.expires_in
              ? { expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() }
              : {}),
          },
          rotated: true,
        };
      },

      async revoke() {
        // Threads publishes no token revocation endpoint. Access is removed by the user in
        // their Threads settings; the engine records the disconnect and stops using the
        // credential.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const { data: user } = await threadsCall<ThreadsUser>(input.context, {
          accessToken: requireAccessToken(input.credentials, 'Threads'),
          method: 'GET',
          path: '/me',
          operation: 'readProfile',
          query: { fields: 'id,username,name,threads_profile_picture_url' },
        });

        return {
          externalAccountId: user.id ?? input.credentials.externalAccountId ?? '',
          displayName: user.name ?? (user.username ? `@${user.username}` : 'Threads'),
          handle: user.username ?? null,
          avatarUrl: user.threads_profile_picture_url ?? null,
          accountType: null,
          grantedScopes: input.credentials.grantedScopes,
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        // One Threads profile per connection — there is no equivalent of a Page. The
        // destination exists as its own record anyway, so the rest of the engine does not
        // need a special case for single-destination providers.
        const { data: user } = await threadsCall<ThreadsUser>(input.context, {
          accessToken: requireAccessToken(input.credentials, 'Threads'),
          method: 'GET',
          path: '/me',
          operation: 'listDestinations',
          query: { fields: 'id,username,name,threads_profile_picture_url' },
        });

        const id = user.id ?? input.credentials.externalAccountId;
        if (!id) return [];

        return [
          {
            externalId: id,
            displayName: user.name ?? (user.username ? `@${user.username}` : 'Threads'),
            handle: user.username ?? null,
            avatarUrl: user.threads_profile_picture_url ?? null,
            kind: 'profile',
            metadata: {},
          },
        ];
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];

        // A URL has no separate field on Threads: it goes in the body and counts against
        // the 500 characters. Checking the combined length is what stops a post that looks
        // fine in the composer and is rejected at publish.
        const effectiveText = content.linkUrl && !content.text.includes(content.linkUrl)
          ? `${content.text}\n${content.linkUrl}`.trim()
          : content.text;

        results.push(
          ...f.collect(
            f.checkTextLength(effectiveText, MAX_TEXT, { code: 'TEXT_TOO_LONG', truncatable: true }),
            f.checkMediaCount(content.media.length, MAX_CAROUSEL),
          ),
        );

        if (effectiveText.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Threads post needs text or media.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        if (content.media.length > 1 && content.media.length < MIN_CAROUSEL) {
          results.push(
            f.error('TOO_FEW_MEDIA_ITEMS', `A Threads carousel needs at least ${MIN_CAROUSEL} items.`, {
              field: 'media',
              agentAction: 'add_media',
            }),
          );
        }

        content.media.forEach((item, index) => {
          const supported = item.kind === 'video' ? SUPPORTED_VIDEO_TYPES : SUPPORTED_IMAGE_TYPES;
          results.push(...f.collect(f.checkMediaType(item.mimeType, supported, index)));
        });

        if (content.linkUrl && !content.text.includes(content.linkUrl)) {
          results.push(
            f.warning('LINK_APPENDED_TO_TEXT', 'Threads has no separate link field, so the URL is appended to the post text and counts toward the 500-character limit.', {
              field: 'content.linkUrl',
              agentAction: 'no_action_required',
            }),
          );
        }

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        const accessToken = requireAccessToken(input.credentials, 'Threads');
        const userId = input.target.destinationExternalId;
        const media = input.content.media;
        const hasMedia = media.length > 0;

        const text = input.content.linkUrl && !input.content.text.includes(input.content.linkUrl)
          ? `${input.content.text}\n${input.content.linkUrl}`.trim()
          : input.content.text;

        const replyControl = input.content.providerOptions.replyControl as string | undefined;
        const containers: string[] = [];

        if (media.length > 1) {
          // Carousel children first, each marked as an item, then a parent referencing them.
          for (const item of media) {
            const { data } = await threadsCall<{ id?: string }>(input.context, {
              accessToken,
              method: 'POST',
              path: `/${userId}/threads`,
              operation: 'createCarouselItem',
              form: {
                media_type: item.kind === 'video' ? 'VIDEO' : 'IMAGE',
                ...(item.kind === 'video' ? { video_url: item.downloadUrl } : { image_url: item.downloadUrl }),
                is_carousel_item: 'true',
                ...(item.altText ? { alt_text: item.altText } : {}),
              },
              timeoutMs: 120_000,
            });

            if (!data.id) throw new GraphError(502, { message: 'Threads did not return a carousel item id.' }, '');
            containers.push(data.id);
          }

          for (const child of containers) {
            await waitForContainer(
              input.context,
              { host: THREADS_HOST, statusField: 'status', accessToken, containerId: child },
              { budgetMs: MEDIA_PROCESSING_BUDGET_MS },
            );
          }

          const { data: parent } = await threadsCall<{ id?: string }>(input.context, {
            accessToken,
            method: 'POST',
            path: `/${userId}/threads`,
            operation: 'createCarouselContainer',
            form: {
              media_type: 'CAROUSEL',
              children: containers.join(','),
              ...(text ? { text } : {}),
              ...(replyControl ? { reply_control: replyControl } : {}),
            },
          });

          if (!parent.id) throw new GraphError(502, { message: 'Threads did not return a container id.' }, '');

          await waitForContainer(
            input.context,
            { host: THREADS_HOST, statusField: 'status', accessToken, containerId: parent.id },
            { budgetMs: TEXT_PROCESSING_BUDGET_MS },
          );

          return { state: { containerId: parent.id }, providerMediaIds: [...containers, parent.id] };
        }

        const single = media[0];
        const { data } = await threadsCall<{ id?: string }>(input.context, {
          accessToken,
          method: 'POST',
          path: `/${userId}/threads`,
          operation: 'createContainer',
          form: {
            media_type: single ? (single.kind === 'video' ? 'VIDEO' : 'IMAGE') : 'TEXT',
            ...(single?.kind === 'video' ? { video_url: single.downloadUrl } : {}),
            ...(single?.kind === 'image' ? { image_url: single.downloadUrl } : {}),
            ...(text ? { text } : {}),
            ...(single?.altText ? { alt_text: single.altText } : {}),
            ...(replyControl ? { reply_control: replyControl } : {}),
            // Threads supports replying to an existing post, which is how a thread is
            // built. Passed straight through as a provider option (plan §43).
            ...(typeof input.content.providerOptions.replyToId === 'string'
              ? { reply_to_id: input.content.providerOptions.replyToId }
              : {}),
          },
          timeoutMs: single ? 120_000 : undefined,
        });

        if (!data.id) throw new GraphError(502, { message: 'Threads did not return a container id.' }, '');

        // Meta's guidance is to wait about 30 seconds before publishing. Polling until the
        // container reports ready is strictly better than sleeping a fixed 30 seconds: it
        // returns as soon as a text post is ready, and waits longer than 30s when a video
        // genuinely needs it.
        await waitForContainer(
          input.context,
          { host: THREADS_HOST, statusField: 'status', accessToken, containerId: data.id },
          { budgetMs: hasMedia ? MEDIA_PROCESSING_BUDGET_MS : TEXT_PROCESSING_BUDGET_MS },
        );

        return { state: { containerId: data.id }, providerMediaIds: [data.id] };
      },

      async publish(input) {
        const accessToken = requireAccessToken(input.credentials, 'Threads');
        const userId = input.target.destinationExternalId;
        const containerId = input.prepared.state.containerId as string | undefined;

        if (!containerId) {
          throw new GraphError(500, { message: 'No Threads container was prepared for this post.' }, '');
        }

        const { data } = await threadsCall<{ id?: string }>(input.context, {
          accessToken,
          method: 'POST',
          path: `/${userId}/threads_publish`,
          operation: 'threadsPublish',
          form: { creation_id: containerId },
        });

        if (!data.id) {
          throw new GraphError(502, { message: 'Threads accepted the publish but returned no post id.' }, '');
        }

        let permalink: string | null = null;
        try {
          const { data: post } = await threadsCall<ThreadsPost>(input.context, {
            accessToken,
            method: 'GET',
            path: `/${data.id}`,
            operation: 'readPermalink',
            query: { fields: 'permalink' },
          });
          permalink = post.permalink ?? null;
        } catch {
          // Already published. A missing permalink is cosmetic and must not turn a
          // successful publish into a retry.
        }

        return {
          outcome: 'published',
          externalPostId: data.id,
          externalUrl: permalink,
          publishedAt: new Date().toISOString(),
          metadata: { containerId },
        };
      },

      async findPossibleDuplicate(input) {
        const accessToken = requireAccessToken(input.credentials, 'Threads');
        const containerId = input.providerMediaIds.at(-1);

        // Same reasoning as Instagram: the container is a real object with a state Meta
        // maintains, so it answers the question directly. Threads makes this more valuable
        // than usual — with 500 characters, short posts repeat, and matching on text alone
        // would readily adopt the wrong one.
        if (containerId) {
          try {
            const state = await readContainerStatus(input.context, {
              host: THREADS_HOST,
              statusField: 'status',
              accessToken,
              containerId,
            });

            if (state.status === 'FINISHED' || state.status === 'IN_PROGRESS') {
              // Processed or still processing, but never published. Provable absence.
              return { conclusion: 'absent' };
            }
          } catch {
            // Fall through to the recent-posts search.
          }
        }

        const limit = 25;
        const { data } = await threadsCall<{ data?: ThreadsPost[] }>(input.context, {
          accessToken,
          method: 'GET',
          path: `/${input.target.destinationExternalId}/threads`,
          operation: 'findPossibleDuplicate',
          query: { fields: 'id,text,timestamp,permalink', limit: String(limit) },
        });

        const posts = data.data ?? [];
        const attemptedAfter = Date.parse(input.attemptedAfter);
        const wanted = input.content.text.trim();

        for (const post of posts) {
          const createdAt = post.timestamp ? Date.parse(post.timestamp) : NaN;
          if (Number.isFinite(createdAt) && createdAt < attemptedAfter) continue;
          if ((post.text ?? '').trim() !== wanted) continue;

          return {
            conclusion: 'found',
            externalPostId: post.id,
            ...(post.permalink ? { externalUrl: post.permalink } : {}),
            ...(post.timestamp ? { publishedAt: new Date(post.timestamp).toISOString() } : {}),
          };
        }

        if (wanted === '') {
          return {
            conclusion: 'indeterminate',
            reason: 'This post has no text, so a matching post cannot be identified from recent posts alone.',
          };
        }

        if (posts.length >= limit) {
          return {
            conclusion: 'indeterminate',
            reason: 'The recent posts page was full, so an earlier matching post cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          await threadsCall(input.context, {
            accessToken: requireAccessToken(input.credentials, 'Threads'),
            method: 'DELETE',
            path: `/${input.externalPostId}`,
            operation: 'deletePost',
          });
          return { alreadyAbsent: false };
        } catch (error) {
          if (error instanceof GraphError && (error.status === 404 || error.subcode === 33)) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ContainerNotReadyError) {
        // Raised only from `prepare`, where nothing has published. Safe to retry.
        return { code: 'MEDIA_PROCESSING_FAILED', message: error.message };
      }

      const shared = normalizeGraphError(error, 'Threads', context.operation);
      if (shared) return shared;

      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401 || status === 403) {
          return { code: 'AUTH_EXPIRED', message: 'Threads rejected the credentials.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Threads returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Threads failure during ${context.operation}.`,
      };
    },
  };
}

/**
 * Upgrade a Threads short-lived token to the ~60-day form.
 *
 * `th_exchange_token`, not `fb_exchange_token` — the grant name is the difference between
 * this working and failing with an error about an unsupported grant type.
 */
async function exchangeForLongLivedThreadsToken(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; accessToken: string },
): Promise<{ accessToken: string; expiresAt: string | undefined }> {
  const { data } = await graphCall<{ access_token?: string; expires_in?: number }>(context, {
    host: THREADS_HOST,
    method: 'GET',
    path: '/access_token',
    operation: 'oauth.long_lived_exchange',
    accessToken: input.accessToken,
    query: { grant_type: 'th_exchange_token', client_secret: input.app.clientSecret },
  });

  if (!data.access_token) {
    throw new GraphError(502, { message: 'Threads did not return a long-lived access token.' }, '');
  }

  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
  };
}

export { GraphError as ThreadsError, DAILY_POST_QUOTA as THREADS_DAILY_POST_QUOTA };
