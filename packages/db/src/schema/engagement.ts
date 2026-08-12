import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { externalPosts } from './analytics.js';
import { socialDestinations } from './connections.js';
import { organizations, profiles, projectEnvironments } from './tenancy.js';

/**
 * Unified comments, conversations and contacts (plan Phase 7).
 *
 * The rule that shapes it: *do not use the provider API as the live backing store for every
 * UI page.* Events arrive by webhook, are persisted here, and the dashboard reads this.
 * Backfill exists for what the webhooks missed, not as the primary path.
 *
 * The reason is the same as analytics, only sharper: an inbox is refreshed constantly. A
 * page that fetches from six providers on every load burns a rate limit that publishing
 * needs and takes seconds to render a list the customer scrolls in milliseconds.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A person on the other side of a comment or message.
 *
 * Per destination, not global. The same human on Instagram and LinkedIn is two contacts,
 * because there is no reliable way to know they are the same person and asserting it would
 * merge two strangers the first time two handles collide.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    externalContactId: text('external_contact_id').notNull(),
    displayName: text('display_name'),
    handle: text('handle'),
    avatarUrl: text('avatar_url'),

    /** True when this contact is the connected account itself, not a member of the public. */
    isSelf: boolean('is_self').notNull().default(false),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('contacts_destination_external_key').on(
      table.destinationId,
      table.externalContactId,
    ),
    index('contacts_profile_idx').on(table.profileId),
  ],
);

/**
 * A comment on a post, ours or somebody else's (plan Phase 7).
 *
 * Threaded by `parent_comment_id` rather than flattened, because replying to the wrong
 * comment in a thread is a visible, public mistake — and a flat list makes an agent
 * choosing a reply target guess at the structure.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    externalPostRowId: uuid('external_post_row_id').references(() => externalPosts.id, {
      onDelete: 'cascade',
    }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    externalCommentId: text('external_comment_id').notNull(),
    /** The provider's id of the comment this replies to. Null for a top-level comment. */
    externalParentId: text('external_parent_id'),
    parentCommentId: uuid('parent_comment_id'),

    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    body: text('body'),

    likeCount: integer('like_count'),
    replyCount: integer('reply_count'),

    /** The provider's own timestamp (Rule 15), not when we ingested it. */
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),

    /** Set when the comment is no longer visible on the platform. */
    deletedDetectedAt: timestamp('deleted_detected_at', { withTimezone: true }),
    /**
     * Handled by a human or an agent. Not a provider concept — it is ours, and it is what
     * turns a firehose into an inbox somebody can actually clear.
     */
    handledAt: timestamp('handled_at', { withTimezone: true }),
    handledBy: text('handled_by'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    /**
     * Ingestion is at-least-once — a webhook redelivery and a backfill both bring the same
     * comment — so without this the inbox would show duplicates and a reply count would
     * climb on its own.
     */
    uniqueIndex('comments_destination_external_key').on(
      table.destinationId,
      table.externalCommentId,
    ),
    index('comments_post_posted_idx').on(table.externalPostRowId, table.postedAt.desc()),
    /** The inbox query: what is waiting, newest first. Partial, because handled is the
     *  eventual state of almost every row. */
    index('comments_unhandled_idx')
      .on(table.projectEnvironmentId, table.postedAt.desc())
      .where(sql`${table.handledAt} IS NULL AND ${table.deletedDetectedAt} IS NULL`),
    index('comments_parent_idx').on(table.parentCommentId),
  ],
);

/** A direct-message thread with one contact (plan Phase 7). */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    /** The provider's thread id. The join key for backfill and for sending a reply. */
    externalThreadId: text('external_thread_id').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),

    subject: text('subject'),
    /** Denormalized so an inbox list does not need a subquery per row. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    unreadCount: integer('unread_count').notNull().default(0),

    handledAt: timestamp('handled_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('conversations_destination_thread_key').on(
      table.destinationId,
      table.externalThreadId,
    ),
    index('conversations_inbox_idx')
      .on(table.projectEnvironmentId, table.lastMessageAt.desc())
      .where(sql`${table.archivedAt} IS NULL`),
  ],
);

/** One message in a conversation. */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    externalMessageId: text('external_message_id').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),

    /** `inbound` from the contact, `outbound` from the connected account. */
    direction: text('direction').notNull(),
    body: text('body'),
    attachments: jsonb('attachments').$type<Record<string, unknown>[]>().notNull().default([]),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Set on a message we sent, linking it to the send attempt.
     *
     * Present because sending is a provider side effect like publishing, and Rule 6
     * requires every one of them to leave an attempt record.
     */
    sentByUserId: text('sent_by_user_id'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('messages_conversation_external_key').on(
      table.conversationId,
      table.externalMessageId,
    ),
    index('messages_conversation_sent_idx').on(table.conversationId, table.sentAt.desc()),
  ],
);

export const commentsRelations = relations(comments, ({ one, many }) => ({
  post: one(externalPosts, {
    fields: [comments.externalPostRowId],
    references: [externalPosts.id],
  }),
  contact: one(contacts, { fields: [comments.contactId], references: [contacts.id] }),
  replies: many(comments, { relationName: 'comment_replies' }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export type Contact = typeof contacts.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
