import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildCapabilities,
  findings as f,
  parseRetryAfter,
  providerFetch,
  ProviderTimeoutError,
  ProviderTransportError,
  restrictCapabilities,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderCallContext,
  type ProviderCredentials,
  type ProviderDestination,
  type SocialProviderAdapter,
} from '@gs/provider-kit';

/**
 * Discord adapter (HTTP API v10, bot token).
 *
 * Official documentation consulted (Rule 2):
 *   https://docs.discord.com/developers/reference
 *   https://docs.discord.com/developers/resources/message
 *   https://docs.discord.com/developers/resources/channel
 *   https://docs.discord.com/developers/resources/guild
 *   https://docs.discord.com/developers/resources/user
 *   https://docs.discord.com/developers/topics/rate-limits
 *
 * Discord needs no approval queue — a bot token from the developer portal is the whole
 * onboarding — which puts it alongside Bluesky and Telegram as a provider that can ship
 * the day the code lands (plan §62.2 lists it last, but nothing gates it).
 *
 * Four things about this API shape the file:
 *
 *   Destinations are channels, and the bot must have been invited. A bot publishes into
 *   text channels of guilds it has joined, so one connection legitimately yields dozens of
 *   destinations — and unlike Telegram, Discord *can* enumerate them.
 *
 *   Permissions are per-channel, not per-token. A bot in a guild may still be unable to
 *   post in a given channel. That is invisible until the send fails with 50013, so it is
 *   normalized as a permission problem rather than a generic 403.
 *
 *   Rate limits are per-route buckets with a JSON `retry_after` in seconds. Discord is
 *   unusually strict about this and escalates to a temporary ban for repeat offenders, so
 *   the value is honoured rather than approximated from headers.
 *
 *   A `User-Agent` is mandatory. Requests without one are rejected by Cloudflare before
 *   Discord sees them, producing an HTML error that parses as nothing.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://discord.com/api/v10';

const DISCORD_API_VERSION = 'v10';

/**
 * Required by the API reference, in the documented shape. Omitting it gets the request
 * blocked at the edge with an HTML body that no JSON parser will explain.
 */
const USER_AGENT = 'DiscordBot (https://gainingsocial.com, 1.0)';

/** Message content is capped at 2000 characters. */
const MAX_CONTENT = 2000;

/** Ten attachments per message, and an attachment description caps at 1024. */
const MAX_ATTACHMENTS = 10;
const MAX_DESCRIPTION = 1024;

/**
 * Upload ceiling for a bot in a guild without a boost tier.
 *
 * Boosted guilds allow more, but boost level is not something this adapter reads, so the
 * limit that always holds is the one validated against (Rule 14).
 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Discord accepts any file type; these are the ones that render inline. */
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

/** Discord channel types. 0 is a guild text channel, 5 an announcement channel. */
const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_ANNOUNCEMENT = 5;

/** Documented error codes worth branching on. */
const CODE_MISSING_ACCESS = 50001;
const CODE_MISSING_PERMISSIONS = 50013;
const CODE_UNKNOWN_CHANNEL = 10003;
const CODE_UNKNOWN_MESSAGE = 10008;
const CODE_UNAUTHORIZED = 40001;

export class DiscordError extends Error {
  readonly status: number;
  /** Discord's numeric JSON error code, e.g. 50013 for missing permissions. */
  readonly code: number | undefined;
  readonly retryAfter: string | undefined;
  /** True when Discord reports the limit as global rather than per-route. */
  readonly global: boolean;

  constructor(
    status: number,
    code: number | undefined,
    message: string,
    options: { retryAfter?: string; global?: boolean } = {},
  ) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.global = options.global ?? false;
  }
}

interface DiscordErrorBody {
  code?: number;
  message?: string;
  retry_after?: number;
  global?: boolean;
}

function toDiscordError(
  status: number,
  body: unknown,
  headers: Headers,
  fallback: string,
): DiscordError {
  const parsed = (body ?? {}) as DiscordErrorBody;

  // Discord puts `retry_after` in the JSON body in seconds — often fractional — which is
  // more precise than the header. Rounding it down would retry too early.
  const retryAfter =
    parsed.retry_after !== undefined
      ? new Date(Date.now() + parsed.retry_after * 1000).toISOString()
      : parseRetryAfter(headers);

  return new DiscordError(status, parsed.code, parsed.message ?? fallback, {
    retryAfter,
    global: parsed.global === true,
  });
}

function botTokenOf(credentials: ProviderCredentials): string {
  if (!credentials.secret) {
    throw new DiscordError(401, CODE_UNAUTHORIZED, 'This connection has no Discord bot token.');
  }
  return credentials.secret;
}

async function call<T>(
  context: ProviderCallContext,
  input: {
    token: string;
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
    path: string;
    body?: unknown;
    form?: FormData;
    timeoutMs?: number;
  },
): Promise<T> {
  const response = await providerFetch(context, `${API_BASE}${input.path}`, {
    operation: input.path.split('?')[0] ?? input.path,
    method: input.method,
    headers: {
      // `Bot ` prefix included. A bare token is read as a user token and rejected.
      authorization: `Bot ${input.token}`,
      'user-agent': USER_AGENT,
      // No content-type for the multipart case: fetch sets it with the boundary.
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.form !== undefined ? { body: input.form } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  if (!response.ok) {
    throw toDiscordError(
      response.status,
      response.json,
      response.headers,
      `Discord returned ${response.status}.`,
    );
  }

  return (response.json ?? {}) as T;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'discord',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      // Several attachments on one message render as a gallery.
      carousel: true,
      // Discord unfurls links in message content on its own.
      link_preview: true,
      // A reply chain via `message_reference`.
      thread: true,
    },
    actions: {
      delete_post: true,
      edit_post: true,
      comments_read: true,
      comments_reply: true,
      dm_send: true,
    },
    constraints: {
      max_text_length: MAX_CONTENT,
      max_media_count: MAX_ATTACHMENTS,
      max_image_bytes: MAX_ATTACHMENT_BYTES,
      max_video_bytes: MAX_ATTACHMENT_BYTES,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      // `attachments[].description` is Discord's alt text.
      supports_alt_text: true,
    },
  });
}

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string;
  discriminator?: string;
  avatar?: string;
  bot?: boolean;
}

interface DiscordGuild {
  id?: string;
  name?: string;
  icon?: string;
}

interface DiscordChannel {
  id?: string;
  name?: string;
  type?: number;
  guild_id?: string;
  position?: number;
}

function avatarUrlOf(user: DiscordUser): string | null {
  if (!user.id || !user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
}

function identityOf(user: DiscordUser): ConnectionIdentity {
  return {
    externalAccountId: user.id ?? '',
    displayName: user.global_name ?? user.username ?? 'Discord bot',
    handle: user.username ? `@${user.username}` : null,
    avatarUrl: avatarUrlOf(user),
    accountType: 'bot',
    grantedScopes: [],
  };
}

/** Only the filename's extension is meaningful to Discord's inline renderer. */
function filenameFor(mimeType: string, mediaId: string): string {
  const extension = mimeType.split('/')[1]?.split('+')[0] ?? 'bin';
  return `${mediaId}.${extension}`;
}

export function createDiscordAdapter(): SocialProviderAdapter {
  return {
    provider: 'discord',
    version: ADAPTER_VERSION,
    // A bot token from the developer portal, pasted by the customer. No OAuth consent
    // screen is involved in publishing, and no app review gates it.
    authStrategy: 'bot_token',
    providerApiVersion: DISCORD_API_VERSION,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      // A bot token carries no OAuth scopes to narrow against. What actually varies is
      // per-channel permission, which Discord only reveals by rejecting the send — so
      // effective capability equals generic here, and a permission failure is reported
      // through the error taxonomy instead of pretended about in advance.
      return restrictCapabilities(generic, []);
    },

    auth: {
      async createAuthorization(input) {
        // No consent screen for publishing. The hosted connect UI collects a bot token
        // directly, and this is where the customer creates one and invites the bot.
        return { authorizationUrl: 'https://discord.com/developers/applications', state: input.state };
      },

      async exchangeCallback(input) {
        const token = input.query.token ?? input.query.bot_token;
        if (!token) {
          throw new DiscordError(400, undefined, 'A Discord bot token is required.');
        }

        // `/users/@me` both validates the token and identifies the bot.
        const user = await call<DiscordUser>(input.context, {
          token,
          method: 'GET',
          path: '/users/@me',
        });

        if (!user.id) {
          throw new DiscordError(401, CODE_UNAUTHORIZED, 'Discord did not accept this bot token.');
        }

        return {
          credentials: {
            strategy: 'bot_token',
            secret: token,
            externalAccountId: user.id,
            grantedScopes: [],
            metadata: { username: user.username ?? null },
          },
          identity: identityOf(user),
        };
      },

      async refresh(input) {
        // A bot token does not expire. It is regenerated by its owner in the developer
        // portal, which invalidates the old one rather than rotating it here.
        return { credentials: input.credentials, rotated: false };
      },

      async revoke() {
        // Only the application's owner can reset a bot token, from the developer portal.
        // Nothing to call; the engine records the disconnect.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const user = await call<DiscordUser>(input.context, {
          token: botTokenOf(input.credentials),
          method: 'GET',
          path: '/users/@me',
        });
        return identityOf(user);
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const token = botTokenOf(input.credentials);

        // Guilds the bot has been invited to. Unlike Telegram, Discord will enumerate
        // these, so destinations are discovered rather than typed in by the customer.
        const guilds = await call<DiscordGuild[]>(input.context, {
          token,
          method: 'GET',
          path: '/users/@me/guilds?limit=200',
        });

        const destinations: ProviderDestination[] = [];

        for (const guild of guilds) {
          if (!guild.id) continue;

          let channels: DiscordChannel[];
          try {
            channels = await call<DiscordChannel[]>(input.context, {
              token,
              method: 'GET',
              path: `/guilds/${encodeURIComponent(guild.id)}/channels`,
            });
          } catch (error) {
            // A guild the bot can see but whose channels it cannot list must not lose the
            // destinations already resolved from other guilds.
            if (
              error instanceof DiscordError &&
              (error.code === CODE_MISSING_ACCESS || error.status === 403)
            ) {
              continue;
            }
            throw error;
          }

          for (const channel of channels) {
            // Only text and announcement channels take a published message. Voice,
            // category and forum channels would each fail differently.
            if (channel.type !== CHANNEL_TYPE_TEXT && channel.type !== CHANNEL_TYPE_ANNOUNCEMENT) {
              continue;
            }
            if (!channel.id) continue;

            destinations.push({
              externalId: channel.id,
              displayName: `${guild.name ?? 'Server'} #${channel.name ?? channel.id}`,
              handle: channel.name ? `#${channel.name}` : null,
              avatarUrl: guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`
                : null,
              kind: channel.type === CHANNEL_TYPE_ANNOUNCEMENT ? 'announcement_channel' : 'text_channel',
              metadata: { guildId: guild.id, guildName: guild.name ?? null },
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

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_CONTENT, { code: 'TEXT_TOO_LONG', truncatable: true }),
            f.checkMediaCount(content.media.length, MAX_ATTACHMENTS),
          ),
        );

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Discord message needs content or an attachment.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        content.media.forEach((item, index) => {
          // Discord accepts any file type; only the size limit is a hard constraint, and
          // it is the one that silently differs by server boost level.
          results.push(...f.collect(f.checkMediaSize(item.bytes, MAX_ATTACHMENT_BYTES, index)));

          if (item.altText !== null && [...item.altText].length > MAX_DESCRIPTION) {
            results.push(
              f.warning(
                'ALT_TEXT_TOO_LONG',
                `The attachment description will be truncated to ${MAX_DESCRIPTION} characters.`,
                { field: `media[${index}].altText`, agentAction: 'shorten_alt_text' },
              ),
            );
          }
        });

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare() {
        // Discord has no separate upload step: attachments are sent in the same multipart
        // request as the message. Fetching the bytes here would mean holding them across
        // the state boundary, which `PreparedPublish` has to serialize — so the fetch
        // happens in `publish` instead, next to the send that needs it.
        return { state: {}, providerMediaIds: [] };
      },

      async publish(input) {
        const token = botTokenOf(input.credentials);
        const channelId = input.target.destinationExternalId;
        const options = input.content.providerOptions;

        const payload: Record<string, unknown> = { content: input.content.text };

        const replyTo = options.replyToMessageId;
        if (typeof replyTo === 'string' && replyTo !== '') {
          payload.message_reference = { message_id: replyTo, channel_id: channelId };
        }

        // Without this, a message containing `@everyone` pings the whole server. Defaulting
        // to no allowed mentions and requiring an explicit opt-in is the safe direction to
        // be wrong in.
        payload.allowed_mentions = Array.isArray(options.allowedMentionParses)
          ? { parse: options.allowedMentionParses }
          : { parse: [] };

        let created: { id?: string; channel_id?: string; timestamp?: string };

        if (input.content.media.length === 0) {
          created = await call(input.context, {
            token,
            method: 'POST',
            path: `/channels/${encodeURIComponent(channelId)}/messages`,
            body: payload,
          });
        } else {
          const form = new FormData();

          // The `attachments` array carries the metadata; `files[n]` carries the bytes,
          // and the `id` in each entry is the index that ties the two together.
          const attachments = input.content.media.map((media, index) => ({
            id: index,
            filename: filenameFor(media.mimeType, media.mediaId),
            ...(media.altText ? { description: media.altText.slice(0, MAX_DESCRIPTION) } : {}),
          }));

          form.set('payload_json', JSON.stringify({ ...payload, attachments }));

          for (const [index, media] of input.content.media.entries()) {
            const source = await fetch(media.downloadUrl, { signal: input.context.signal });
            if (!source.ok) {
              throw new DiscordError(source.status, undefined, 'Could not read the media file.');
            }
            form.set(
              `files[${index}]`,
              new Blob([await source.arrayBuffer()], { type: media.mimeType }),
              filenameFor(media.mimeType, media.mediaId),
            );
          }

          created = await call(input.context, {
            token,
            method: 'POST',
            path: `/channels/${encodeURIComponent(channelId)}/messages`,
            form,
            timeoutMs: 120_000,
          });
        }

        if (!created.id) {
          throw new DiscordError(502, undefined, 'Discord did not return a message id.');
        }

        const guildId = input.content.providerOptions.guildId;
        return {
          outcome: 'published',
          externalPostId: created.id,
          // The guild is needed for a jump link. When it is not known, the channel-scoped
          // form still resolves for anyone with access.
          externalUrl:
            typeof guildId === 'string' && guildId
              ? `https://discord.com/channels/${guildId}/${channelId}/${created.id}`
              : `https://discord.com/channels/@me/${channelId}/${created.id}`,
          publishedAt: created.timestamp
            ? new Date(created.timestamp).toISOString()
            : new Date().toISOString(),
          metadata: { channelId },
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. Discord offers no idempotency key on message creation, so the
        // channel's own recent history is the check — and it is a good one, because a
        // message can only be in the channel it was sent to.
        const wanted = input.content.text.trim();
        if (wanted === '') {
          // An attachment-only message cannot be matched on text, and matching on timing
          // alone is the reasoning that duplicates posts. Checked before the request so an
          // unanswerable question costs nothing.
          return {
            conclusion: 'indeterminate',
            reason: 'The message has no text content, so it cannot be identified in the channel history.',
          };
        }

        const channelId = encodeURIComponent(input.target.destinationExternalId);
        const botId = input.credentials.externalAccountId;

        const messages = await call<
          { id?: string; content?: string; timestamp?: string; author?: { id?: string } }[]
        >(input.context, {
          token: botTokenOf(input.credentials),
          method: 'GET',
          path: `/channels/${channelId}/messages?limit=50`,
        });

        const attemptedAfter = Date.parse(input.attemptedAfter);

        for (const message of messages) {
          // Only our own bot's messages count. Another member posting the same words is
          // not our duplicate.
          if (botId && message.author?.id !== botId) continue;

          const sentAt = message.timestamp ? Date.parse(message.timestamp) : undefined;
          if (sentAt !== undefined && sentAt < attemptedAfter - 60_000) continue;

          if ((message.content ?? '').trim() === wanted && message.id) {
            return {
              conclusion: 'found',
              externalPostId: message.id,
              externalUrl: `https://discord.com/channels/@me/${input.target.destinationExternalId}/${message.id}`,
              ...(sentAt !== undefined ? { publishedAt: new Date(sentAt).toISOString() } : {}),
            };
          }
        }

        if (messages.length >= 50) {
          return {
            conclusion: 'indeterminate',
            reason: 'The channel history page was full, so a matching message cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        try {
          await call(input.context, {
            token: botTokenOf(input.credentials),
            method: 'DELETE',
            path: `/channels/${encodeURIComponent(input.target.destinationExternalId)}/messages/${encodeURIComponent(input.externalPostId)}`,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          if (
            error instanceof DiscordError &&
            (error.status === 404 || error.code === CODE_UNKNOWN_MESSAGE)
          ) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `Discord timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Discord was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof DiscordError) {
        // Branch on Discord's numeric code first: a bot that was removed from a server and
        // a bot missing one channel permission are both 403, and they need different
        // handling.
        switch (error.code) {
          case CODE_UNAUTHORIZED:
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case CODE_MISSING_PERMISSIONS:
            return {
              code: 'AUTH_SCOPE_MISSING',
              message: `${error.message} The bot needs the Send Messages permission in this channel.`,
              status: error.status,
            };
          case CODE_MISSING_ACCESS:
            return {
              code: 'AUTH_SCOPE_MISSING',
              message: `${error.message} The bot may have been removed from this server.`,
              status: error.status,
            };
          case CODE_UNKNOWN_CHANNEL:
          case CODE_UNKNOWN_MESSAGE:
            return { code: 'DESTINATION_NOT_FOUND', message: error.message, status: error.status };
        }

        if (error.status === 429) {
          return {
            code: 'RATE_LIMITED',
            message: error.global
              ? `${error.message} This is a global limit across the whole bot.`
              : error.message,
            status: 429,
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
        if (error.status === 413) {
          return { code: 'MEDIA_TOO_LARGE', message: error.message, status: 413 };
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
          return { code: 'AUTH_EXPIRED', message: 'Discord rejected the bot token.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'Discord is rate limiting this bot.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Discord returned a server error.', status };
        }
      }

      // Rule 14 — not auto-retried. Discord has no idempotency key, so a blind retry
      // posts the message twice.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Discord failure during ${context.operation}.`,
      };
    },
  };
}
