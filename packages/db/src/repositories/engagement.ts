import { newUuidV7 } from '@gs/contracts/ids';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  comments,
  contacts,
  conversations,
  messages,
  type Comment,
  type Contact,
  type Conversation,
  type Message,
} from '../schema/engagement.js';

/**
 * Comments, conversations and contacts (plan Phase 7).
 *
 * Every ingest path here is an upsert, because every one of them is at-least-once: a
 * webhook redelivery and a backfill sweep both bring the same comment, and the two run
 * concurrently by design. Without the upserts an inbox would fill with duplicates and its
 * unread count would climb on its own.
 */

export interface UpsertContactInput {
  destinationId: string;
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  provider: string;
  externalContactId: string;
  displayName?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  isSelf?: boolean;
}

export async function upsertContact(db: Database, input: UpsertContactInput): Promise<string> {
  const id = newUuidV7();

  const rows = await db
    .insert(contacts)
    .values({
      id,
      destinationId: input.destinationId,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      provider: input.provider,
      externalContactId: input.externalContactId,
      displayName: input.displayName ?? null,
      handle: input.handle ?? null,
      avatarUrl: input.avatarUrl ?? null,
      isSelf: input.isSelf ?? false,
    })
    .onConflictDoUpdate({
      target: [contacts.destinationId, contacts.externalContactId],
      set: {
        // Refreshed when supplied, kept when not. A backfill that returns only an id must
        // not blank a display name a webhook already gave us.
        displayName: sql`coalesce(excluded.display_name, ${contacts.displayName})`,
        handle: sql`coalesce(excluded.handle, ${contacts.handle})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${contacts.avatarUrl})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });

  return rows[0]!.id;
}

export interface UpsertCommentInput {
  externalPostRowId?: string | null;
  destinationId: string;
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  provider: string;
  externalCommentId: string;
  externalParentId?: string | null;
  contactId?: string | null;
  body?: string | null;
  likeCount?: number | null;
  replyCount?: number | null;
  postedAt?: Date | null;
}

/**
 * Record a comment.
 *
 * `handled_at` is never touched on conflict. A redelivered webhook must not un-handle a
 * comment somebody already replied to and cleared — which would put it back at the top of
 * the inbox and invite a second reply to the same person.
 */
export async function upsertComment(
  db: Database,
  input: UpsertCommentInput,
): Promise<{ id: string; created: boolean }> {
  const id = newUuidV7();

  const rows = await db
    .insert(comments)
    .values({
      id,
      externalPostRowId: input.externalPostRowId ?? null,
      destinationId: input.destinationId,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      provider: input.provider,
      externalCommentId: input.externalCommentId,
      externalParentId: input.externalParentId ?? null,
      contactId: input.contactId ?? null,
      body: input.body ?? null,
      likeCount: input.likeCount ?? null,
      replyCount: input.replyCount ?? null,
      postedAt: input.postedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [comments.destinationId, comments.externalCommentId],
      set: {
        body: sql`coalesce(excluded.body, ${comments.body})`,
        likeCount: sql`coalesce(excluded.like_count, ${comments.likeCount})`,
        replyCount: sql`coalesce(excluded.reply_count, ${comments.replyCount})`,
        contactId: sql`coalesce(${comments.contactId}, excluded.contact_id)`,
        externalPostRowId: sql`coalesce(${comments.externalPostRowId}, excluded.external_post_row_id)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: comments.id });

  const row = rows[0]!;
  return { id: row.id, created: row.id === id };
}

/** Resolve the internal parent once both comments are present. */
export async function linkCommentParent(
  db: Database,
  commentId: string,
  parentCommentId: string,
): Promise<void> {
  await db
    .update(comments)
    .set({ parentCommentId, updatedAt: new Date() })
    .where(eq(comments.id, commentId));
}

export interface ListCommentsInput {
  projectEnvironmentId: string;
  profileId?: string | null;
  destinationId?: string | null;
  externalPostRowId?: string | null;
  /** Default. The inbox is the unhandled set; everything else is history. */
  onlyUnhandled?: boolean;
  limit: number;
}

export async function listComments(db: Database, input: ListCommentsInput): Promise<Comment[]> {
  const conditions = [
    eq(comments.projectEnvironmentId, input.projectEnvironmentId),
    // A comment the platform no longer shows cannot be replied to, so showing it in an
    // inbox only invites a reply that will fail.
    isNull(comments.deletedDetectedAt),
  ];

  if (input.profileId) conditions.push(eq(comments.profileId, input.profileId));
  if (input.destinationId) conditions.push(eq(comments.destinationId, input.destinationId));
  if (input.externalPostRowId) {
    conditions.push(eq(comments.externalPostRowId, input.externalPostRowId));
  }
  if (input.onlyUnhandled !== false) conditions.push(isNull(comments.handledAt));

  return db
    .select()
    .from(comments)
    .where(and(...conditions))
    .orderBy(desc(comments.postedAt))
    .limit(input.limit);
}

export async function findCommentById(
  db: Database,
  projectEnvironmentId: string,
  commentId: string,
): Promise<Comment | null> {
  const rows = await db
    .select()
    .from(comments)
    .where(
      and(eq(comments.id, commentId), eq(comments.projectEnvironmentId, projectEnvironmentId)),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Mark a comment dealt with.
 *
 * Conditional on it not already being handled, and reports whether it moved. Two people
 * working the same inbox is the normal case, and the caller uses the answer to avoid
 * sending a second reply to somebody who already got one.
 */
export async function markCommentHandled(
  db: Database,
  commentId: string,
  handledBy: string,
): Promise<boolean> {
  const rows = await db
    .update(comments)
    .set({ handledAt: new Date(), handledBy, updatedAt: new Date() })
    .where(and(eq(comments.id, commentId), isNull(comments.handledAt)))
    .returning({ id: comments.id });

  return rows.length > 0;
}

export async function markCommentDeleted(db: Database, commentId: string): Promise<void> {
  await db
    .update(comments)
    .set({ deletedDetectedAt: new Date(), updatedAt: new Date() })
    .where(eq(comments.id, commentId));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface UpsertConversationInput {
  destinationId: string;
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  provider: string;
  externalThreadId: string;
  contactId?: string | null;
  subject?: string | null;
}

export async function upsertConversation(
  db: Database,
  input: UpsertConversationInput,
): Promise<string> {
  const id = newUuidV7();

  const rows = await db
    .insert(conversations)
    .values({
      id,
      destinationId: input.destinationId,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      provider: input.provider,
      externalThreadId: input.externalThreadId,
      contactId: input.contactId ?? null,
      subject: input.subject ?? null,
    })
    .onConflictDoUpdate({
      target: [conversations.destinationId, conversations.externalThreadId],
      set: {
        contactId: sql`coalesce(${conversations.contactId}, excluded.contact_id)`,
        subject: sql`coalesce(excluded.subject, ${conversations.subject})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: conversations.id });

  return rows[0]!.id;
}

export interface RecordMessageInput {
  conversationId: string;
  projectEnvironmentId: string;
  provider: string;
  externalMessageId: string;
  contactId?: string | null;
  direction: 'inbound' | 'outbound';
  body?: string | null;
  sentAt?: Date | null;
  sentByUserId?: string | null;
}

/**
 * Record a message and roll the conversation summary forward.
 *
 * The summary is only advanced when the message is genuinely new, and only when it is
 * newer than what is already there. A backfill walking history backwards would otherwise
 * rewrite `last_message_at` with an older timestamp and drop the thread to the bottom of
 * an inbox somebody is actively working.
 */
export async function recordMessage(
  db: Database,
  input: RecordMessageInput,
): Promise<{ id: string; created: boolean }> {
  const id = newUuidV7();
  const sentAt = input.sentAt ?? new Date();

  const inserted = await db
    .insert(messages)
    .values({
      id,
      conversationId: input.conversationId,
      projectEnvironmentId: input.projectEnvironmentId,
      provider: input.provider,
      externalMessageId: input.externalMessageId,
      contactId: input.contactId ?? null,
      direction: input.direction,
      body: input.body ?? null,
      sentAt,
      sentByUserId: input.sentByUserId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });

  if (inserted.length === 0) return { id, created: false };

  await db
    .update(conversations)
    .set({
      lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, 'epoch'::timestamptz), ${sentAt.toISOString()}::timestamptz)`,
      lastMessagePreview: sql`case
        when ${conversations.lastMessageAt} is null or ${conversations.lastMessageAt} <= ${sentAt.toISOString()}::timestamptz
        then ${input.body ?? null}
        else ${conversations.lastMessagePreview}
      end`,
      // Only inbound messages are unread. Counting our own replies would mean answering
      // somebody made the thread look more urgent.
      unreadCount:
        input.direction === 'inbound'
          ? sql`${conversations.unreadCount} + 1`
          : conversations.unreadCount,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, input.conversationId));

  return { id: inserted[0]!.id, created: true };
}

export interface ListConversationsInput {
  projectEnvironmentId: string;
  profileId?: string | null;
  includeArchived?: boolean;
  limit: number;
}

export async function listConversations(
  db: Database,
  input: ListConversationsInput,
): Promise<Conversation[]> {
  const conditions = [eq(conversations.projectEnvironmentId, input.projectEnvironmentId)];

  if (input.profileId) conditions.push(eq(conversations.profileId, input.profileId));
  if (!input.includeArchived) conditions.push(isNull(conversations.archivedAt));

  return db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(input.limit);
}

export async function findConversationById(
  db: Database,
  projectEnvironmentId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listMessages(
  db: Database,
  conversationId: string,
  limit: number,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sentAt))
    .limit(limit);
}

/** Clear the unread count once somebody has looked. */
export async function markConversationRead(db: Database, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export async function findContactById(db: Database, contactId: string): Promise<Contact | null> {
  const rows = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  return rows[0] ?? null;
}
