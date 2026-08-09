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
 * Telegram adapter (Bot API).
 *
 * Official documentation consulted (Rule 2):
 *   https://core.telegram.org/bots/api#sendmessage
 *   https://core.telegram.org/bots/api#sendphoto
 *   https://core.telegram.org/bots/api#sendmediagroup
 *   https://core.telegram.org/bots/api#making-requests
 *
 * Telegram is a Phase-1 reference provider (plan §62.1) alongside Bluesky, and for the
 * same reason: a bot token from @BotFather is the entire onboarding. No developer portal,
 * no review queue, no waiting.
 *
 * Two ways it differs from a conventional social network, both of which shape this file:
 *
 *   Destinations are chats, not a feed. A bot publishes into channels and groups it has
 *   been added to, so a "destination" is a chat id — and unlike Bluesky, one bot can
 *   legitimately have many.
 *
 *   The bot cannot enumerate its own chats. The Bot API deliberately offers no "list my
 *   chats" method, so destinations cannot be discovered automatically the way a Meta page
 *   list can. They are supplied by the customer.
 */

export const ADAPTER_VERSION = '1.0.0';

const API_BASE = 'https://api.telegram.org';

/**
 * Documented limits.
 *
 *   text     4096 characters, after entity parsing
 *   caption  1024 characters — a quarter of a plain message, and the single most common
 *            surprise when attaching an image to a long post
 *   album    2-10 items. A single item is sent as a photo instead, and more than ten
 *            is rejected
 */
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_ALBUM = 10;

/** `HTML` and `MarkdownV2` are the documented parse modes. Plain text needs neither. */
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const SUPPORTED_VIDEO_TYPES = ['video/mp4'] as const;

/** A Bot API error. `error_code` and `description` are the documented failure shape. */
export class TelegramError extends Error {
  readonly errorCode: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(errorCode: number, description: string, retryAfterSeconds?: number) {
    super(description);
    this.name = 'TelegramError';
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  /** Present on 429. Telegram tells you exactly how long to wait. */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

async function call<T>(
  context: ProviderCallContext,
  input: { token: string; method: string; body?: Record<string, unknown>; timeoutMs?: number },
): Promise<T> {
  // The token sits in the URL path, which is Telegram's design. `providerFetch` logs the
  // path only after stripping the query string — but the token is in the path itself, so
  // the operation name is logged rather than a URL that would leak it (P9).
  const url = `${API_BASE}/bot${input.token}/${input.method}`;

  const response = await providerFetch(context, url, {
    operation: input.method,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.body ?? {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  const body = (response.json ?? {}) as TelegramResponse<T>;

  if (!response.ok || !body.ok) {
    throw new TelegramError(
      body.error_code ?? response.status,
      body.description ?? `Telegram returned ${response.status}.`,
      body.parameters?.retry_after ??
        (parseRetryAfter(response.headers)
          ? Math.max(0, Math.round((Date.parse(parseRetryAfter(response.headers)!) - Date.now()) / 1000))
          : undefined),
    );
  }

  return body.result as T;
}

function tokenOf(credentials: ProviderCredentials): string {
  if (!credentials.secret) {
    throw new TelegramError(401, 'This connection has no Telegram bot token.');
  }
  return credentials.secret;
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'telegram',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      // sendMediaGroup is Telegram's album, which is the carousel equivalent.
      carousel: true,
      link_preview: true,
    },
    actions: {
      delete_post: true,
    },
    constraints: {
      max_text_length: MAX_TEXT,
      max_media_count: MAX_ALBUM,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      // The Bot API has no alt-text field on photos.
      supports_alt_text: false,
    },
  });
}

interface BotUser {
  id: number;
  username?: string;
  first_name: string;
}

interface Chat {
  id: number;
  title?: string;
  username?: string;
  type: string;
}

interface Message {
  message_id: number;
  chat: Chat;
  date: number;
}

export function createTelegramAdapter(): SocialProviderAdapter {
  return {
    provider: 'telegram',
    version: ADAPTER_VERSION,
    // Plan §20. Like Bluesky, no registered platform application is involved.
    authStrategy: 'bot_token',
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;
      // A bot token grants everything the Bot API offers to that bot; there is no scope
      // model to narrow against.
      return restrictCapabilities(generic, []);
    },

    auth: {
      async createAuthorization(input) {
        // No consent screen. The hosted connect UI collects a bot token directly, and
        // this URL is where the customer creates one.
        return { authorizationUrl: 'https://t.me/BotFather', state: input.state };
      },

      async exchangeCallback(input) {
        const token = input.query.token ?? input.query.bot_token;
        if (!token) {
          throw new TelegramError(400, 'A Telegram bot token is required.');
        }

        // getMe both validates the token and identifies the bot.
        const bot = await call<BotUser>(input.context, { token, method: 'getMe' });

        return {
          credentials: {
            strategy: 'bot_token',
            secret: token,
            externalAccountId: String(bot.id),
            grantedScopes: [],
            metadata: { username: bot.username ?? null },
          },
          identity: {
            externalAccountId: String(bot.id),
            displayName: bot.first_name,
            handle: bot.username ? `@${bot.username}` : null,
            avatarUrl: null,
            accountType: 'bot',
            grantedScopes: [],
          },
        };
      },

      async refresh(input) {
        // A bot token does not expire. It is revoked by the owner in @BotFather.
        return { credentials: input.credentials, rotated: false };
      },

      async revoke() {
        // Only the bot's owner can revoke a token, through @BotFather. Nothing to call.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const bot = await call<BotUser>(input.context, {
          token: tokenOf(input.credentials),
          method: 'getMe',
        });

        return {
          externalAccountId: String(bot.id),
          displayName: bot.first_name,
          handle: bot.username ? `@${bot.username}` : null,
          avatarUrl: null,
          accountType: 'bot',
          grantedScopes: [],
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        // The Bot API deliberately provides no method to enumerate a bot's chats, so
        // there is nothing to discover. Destinations are the chat ids the customer
        // supplies during connect, stored in connection metadata.
        //
        // Returning an empty list rather than inventing one is the honest answer: a
        // fabricated destination would fail at publish time with a confusing error.
        const configured = input.credentials.metadata.chats;
        if (!Array.isArray(configured)) return [];

        return configured
          .filter((chat): chat is { id: string; title?: string } =>
            typeof chat === 'object' && chat !== null && 'id' in chat,
          )
          .map((chat) => ({
            externalId: String(chat.id),
            displayName: chat.title ?? `Chat ${chat.id}`,
            handle: null,
            avatarUrl: null,
            kind: 'channel',
            metadata: {},
          }));
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call — plan §18 forbids side effects here.
        const { content } = input;
        const results: ValidationFinding[] = [];
        const hasMedia = content.media.length > 0;

        // The limit depends on whether media is attached, and the difference is large:
        // 4096 for a plain message, 1024 for a caption. Checking only the larger one lets
        // a post through that Telegram then rejects.
        const limit = hasMedia ? MAX_CAPTION : MAX_TEXT;
        const length = [...content.text].length;

        if (length > limit) {
          results.push(
            f.error(
              'TEXT_TOO_LONG',
              hasMedia
                ? `A caption is limited to ${MAX_CAPTION} characters; this has ${length}. Without an image the limit is ${MAX_TEXT}.`
                : `Telegram allows ${MAX_TEXT} characters; this has ${length}.`,
              {
                field: 'content.text',
                agentAction: 'shorten_text',
                autofix: {
                  kind: 'truncate_text',
                  description: `Truncate to ${limit} characters.`,
                  parameters: { max_length: limit },
                },
              },
            ),
          );
        }

        if (content.text.trim() === '' && !hasMedia) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Telegram message needs text or media.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        if (content.media.length > MAX_ALBUM) {
          results.push(
            f.error('TOO_MANY_MEDIA_ITEMS', `An album holds at most ${MAX_ALBUM} items.`, {
              field: 'media',
              agentAction: 'remove_media',
              autofix: {
                kind: 'remove_media',
                description: `Keep the first ${MAX_ALBUM} items.`,
                parameters: { keep_first: MAX_ALBUM },
              },
            }),
          );
        }

        content.media.forEach((item, index) => {
          const supported = item.kind === 'video' ? SUPPORTED_VIDEO_TYPES : SUPPORTED_IMAGE_TYPES;
          results.push(...f.collect(f.checkMediaType(item.mimeType, supported, index)));

          if (item.altText) {
            // Surfaced rather than dropped silently: the author wrote alt text and it
            // will not appear anywhere, which they would otherwise never discover.
            results.push(
              f.warning('MEDIA_ALT_TEXT_UNSUPPORTED', 'Telegram has no alt text field; it will be omitted.', {
                field: `media[${index}]`,
                agentAction: 'ignore',
              }),
            );
          }
        });

        return { findings: results, estimatedTransformations: [] };
      },

      async prepare(input) {
        // Telegram accepts a URL for each media item and fetches it itself, so there is
        // no upload step. The signed media URLs are already in the content.
        return { state: {}, providerMediaIds: input.content.media.map((item) => item.mediaId) };
      },

      async publish(input) {
        const token = tokenOf(input.credentials);
        const chatId = input.target.destinationExternalId;
        const media = input.content.media;
        const text = input.content.text;

        let message: Message;

        if (media.length === 0) {
          message = await call<Message>(input.context, {
            token,
            method: 'sendMessage',
            body: { chat_id: chatId, text },
          });
        } else if (media.length === 1) {
          const only = media[0]!;
          message = await call<Message>(input.context, {
            token,
            method: only.kind === 'video' ? 'sendVideo' : 'sendPhoto',
            body: {
              chat_id: chatId,
              [only.kind === 'video' ? 'video' : 'photo']: only.downloadUrl,
              ...(text ? { caption: text } : {}),
            },
            timeoutMs: 60_000,
          });
        } else {
          // An album. Only the first item carries the caption — Telegram shows one
          // caption per group, and putting it on every item duplicates it visibly.
          const group = await call<Message[]>(input.context, {
            token,
            method: 'sendMediaGroup',
            body: {
              chat_id: chatId,
              media: media.slice(0, MAX_ALBUM).map((item, index) => ({
                type: item.kind === 'video' ? 'video' : 'photo',
                media: item.downloadUrl,
                ...(index === 0 && text ? { caption: text } : {}),
              })),
            },
            timeoutMs: 120_000,
          });

          const first = group[0];
          if (!first) throw new TelegramError(500, 'sendMediaGroup returned no messages.');
          message = first;
        }

        // A public link only exists for a channel with a username. A numeric-only chat is
        // private, and inventing a URL for it would produce a link that 404s.
        const username = message.chat.username;
        const url = username ? `https://t.me/${username}/${message.message_id}` : null;

        return {
          outcome: 'published',
          // Composite, because a message id is only unique within its chat.
          externalPostId: `${message.chat.id}:${message.message_id}`,
          externalUrl: url,
          publishedAt: new Date(message.date * 1000).toISOString(),
          metadata: { chatId: message.chat.id, messageId: message.message_id },
        };
      },

      async delete(input) {
        const [chatId, messageId] = input.externalPostId.split(':');
        if (!chatId || !messageId) return { alreadyAbsent: true };

        try {
          await call(input.context, {
            token: tokenOf(input.credentials),
            method: 'deleteMessage',
            body: { chat_id: chatId, message_id: Number(messageId) },
          });
          return { alreadyAbsent: false };
        } catch (error) {
          // Telegram reports an already-deleted message as a 400. Deleting twice must
          // not be an error (P4).
          if (error instanceof TelegramError && error.errorCode === 400) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      if (error instanceof ProviderTimeoutError) {
        return { code: 'PROVIDER_TIMEOUT', message: `Telegram timed out during ${context.operation}.` };
      }
      if (error instanceof ProviderTransportError) {
        return { code: 'PROVIDER_UNAVAILABLE', message: `Telegram was unreachable during ${context.operation}.` };
      }

      if (error instanceof TelegramError) {
        // 429 carries `retry_after`, which is an exact instruction rather than a guess.
        if (error.errorCode === 429) {
          return {
            code: 'RATE_LIMITED',
            message: error.message,
            status: 429,
            retryAfter:
              error.retryAfterSeconds === undefined
                ? undefined
                : new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString(),
          };
        }

        if (error.errorCode === 401) {
          return { code: 'AUTH_REVOKED', message: 'The bot token is not valid.', status: 401 };
        }

        // 403 from Telegram almost always means the bot was removed from the chat or
        // blocked — a connection problem a human must fix, not a content problem.
        if (error.errorCode === 403) {
          return {
            code: 'AUTH_REVOKED',
            message: 'The bot was removed from this chat, or lacks permission to post in it.',
            status: 403,
          };
        }

        if (error.errorCode === 400) {
          // "chat not found" is a destination problem; everything else at 400 is content.
          if (/chat not found/i.test(error.message)) {
            return { code: 'DESTINATION_NOT_FOUND', message: error.message, status: 400 };
          }
          return { code: 'VALIDATION_FAILED', message: error.message, status: 400 };
        }

        if (error.errorCode >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: error.message, status: error.errorCode };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried, because a retry could
      // duplicate a message we cannot prove was not sent.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Telegram failure during ${context.operation}.`,
      };
    },
  };
}
