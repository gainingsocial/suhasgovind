import {
  CommentListResponseSchema,
  CommentSchema,
  ConversationListResponseSchema,
  ConversationSchema,
  MessageListResponseSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  findCommentById,
  findContactById,
  findConversationById,
  listComments,
  listConversations,
  listMessages,
  markConversationRead,
  type Comment,
  type Contact,
  type Conversation,
  type Database,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { requirePathId } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * The unified inbox (plan Phase 7).
 *
 * Reads come from our own store. Plan Phase 7 is explicit that the provider API must not be
 * the live backing store for every UI page, and an inbox makes the point sharper than
 * analytics does: it is refreshed constantly, so fetching from six platforms per load would
 * spend a rate limit publishing depends on to render a list somebody scrolls past in a
 * second.
 *
 * Replying is the opposite: it goes through an adapter, because it is a provider side
 * effect and belongs on the same path as publishing (plan §19).
 */
export const comments = new Hono<AppEnv>();
export const conversations = new Hono<AppEnv>();

const PAGE_SIZE = 50;

function toContact(contact: Contact | null) {
  if (!contact) return null;

  return {
    id: toPublicId('profile', contact.id),
    object: 'contact' as const,
    display_name: contact.displayName,
    handle: contact.handle,
    avatar_url: contact.avatarUrl,
  };
}

async function toCommentResponse(db: Database, row: Comment) {
  const author = row.contactId ? await findContactById(db, row.contactId) : null;

  return CommentSchema.parse({
    id: toPublicId('event', row.id),
    object: 'comment',
    provider: isProviderName(row.provider) ? row.provider : 'mock',
    destination_id: toPublicId('destination', row.destinationId),
    post_id: row.externalPostRowId ? toPublicId('post', row.externalPostRowId) : null,
    external_comment_id: row.externalCommentId,
    parent_comment_id: row.parentCommentId ? toPublicId('event', row.parentCommentId) : null,
    author: toContact(author),
    body: row.body,
    like_count: row.likeCount,
    reply_count: row.replyCount,
    // Rule 15 — the provider's own timestamp, UTC.
    posted_at: row.postedAt?.toISOString() ?? null,
    handled_at: row.handledAt?.toISOString() ?? null,
  });
}

async function toConversationResponse(db: Database, row: Conversation) {
  const contact = row.contactId ? await findContactById(db, row.contactId) : null;

  return ConversationSchema.parse({
    id: toPublicId('event', row.id),
    object: 'conversation',
    provider: isProviderName(row.provider) ? row.provider : 'mock',
    destination_id: toPublicId('destination', row.destinationId),
    contact: toContact(contact),
    subject: row.subject,
    last_message_at: row.lastMessageAt?.toISOString() ?? null,
    last_message_preview: row.lastMessagePreview,
    unread_count: row.unreadCount,
  });
}

function resolveProfileScope(
  restrictedTo: string | null,
  requested: string | undefined,
): string | null {
  // A profile-restricted key sees one profile whether or not it names one (plan §38).
  if (restrictedTo) return restrictedTo;
  if (!requested) return null;

  const resolved = fromPublicId('profile', requested);
  if (!resolved) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  return resolved;
}

comments.get('/', withDatabase(), authenticate(['inbox:read']), async (c) => {
  const principal = c.get('principal');

  const rows = await listComments(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId: resolveProfileScope(principal.restrictedToProfileId, c.req.query('profile_id')),
    // The inbox is the unhandled set by default. `?handled=all` shows history, because
    // "what did we reply to last week" is a real question and the rows are still here.
    onlyUnhandled: c.req.query('handled') !== 'all',
    limit: PAGE_SIZE + 1,
  });

  const page = rows.slice(0, PAGE_SIZE);
  const data = await Promise.all(page.map((row) => toCommentResponse(c.get('db'), row)));

  return c.json(
    CommentListResponseSchema.parse({
      object: 'list',
      data,
      has_more: rows.length > PAGE_SIZE,
      next_cursor: null,
    }),
    200,
  );
});

comments.get('/:commentId', withDatabase(), authenticate(['inbox:read']), async (c) => {
  const principal = c.get('principal');
  const commentId = requirePathId(c, 'event', 'commentId');

  const row = await findCommentById(c.get('db'), principal.projectEnvironmentId, commentId);
  if (!row) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such comment.' });

  if (principal.restrictedToProfileId && principal.restrictedToProfileId !== row.profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return c.json(await toCommentResponse(c.get('db'), row), 200);
});

conversations.get('/', withDatabase(), authenticate(['inbox:read']), async (c) => {
  const principal = c.get('principal');

  const rows = await listConversations(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId: resolveProfileScope(principal.restrictedToProfileId, c.req.query('profile_id')),
    includeArchived: c.req.query('include_archived') === 'true',
    limit: PAGE_SIZE + 1,
  });

  const page = rows.slice(0, PAGE_SIZE);
  const data = await Promise.all(page.map((row) => toConversationResponse(c.get('db'), row)));

  return c.json(
    ConversationListResponseSchema.parse({
      object: 'list',
      data,
      has_more: rows.length > PAGE_SIZE,
      next_cursor: null,
    }),
    200,
  );
});

conversations.get('/:conversationId/messages', withDatabase(), authenticate(['inbox:read']), async (c) => {
  const principal = c.get('principal');
  const conversationId = requirePathId(c, 'event', 'conversationId');

  const conversation = await findConversationById(
    c.get('db'),
    principal.projectEnvironmentId,
    conversationId,
  );
  if (!conversation) {
    throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such conversation.' });
  }

  if (
    principal.restrictedToProfileId &&
    principal.restrictedToProfileId !== conversation.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  const rows = await listMessages(c.get('db'), conversationId, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);

  /**
   * Reading the thread clears its unread count.
   *
   * Done here rather than behind a separate endpoint, because a client that has to
   * remember a second call will forget it, and an inbox whose badge never clears is one
   * people stop trusting.
   */
  if (conversation.unreadCount > 0) {
    await markConversationRead(c.get('db'), conversationId);
  }

  return c.json(
    MessageListResponseSchema.parse({
      object: 'list',
      conversation_id: toPublicId('event', conversationId),
      data: page.map((row) => ({
        id: toPublicId('event', row.id),
        object: 'message',
        direction: row.direction as 'inbound' | 'outbound',
        body: row.body,
        sent_at: row.sentAt?.toISOString() ?? null,
      })),
      has_more: rows.length > PAGE_SIZE,
      next_cursor: null,
    }),
    200,
  );
});
