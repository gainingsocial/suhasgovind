import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';

/**
 * Unified comments and conversations (plan Phase 7).
 *
 * Read from our own store, never live from a provider. An inbox is refreshed constantly,
 * and a page that fetches from six platforms on every load burns a rate limit publishing
 * needs while taking seconds to render a list the customer scrolls in milliseconds.
 */
export const ContactSchema = z
  .object({
    id: z.string(),
    object: z.literal('contact'),
    display_name: z.string().nullable(),
    handle: z.string().nullable(),
    avatar_url: z.string().nullable(),
  })
  .strict();

export const CommentSchema = z
  .object({
    id: z.string(),
    object: z.literal('comment'),
    provider: ProviderNameSchema,
    destination_id: z.string(),
    /** The post this comment is on, when we know which one. */
    post_id: z.string().nullable(),
    external_comment_id: z.string(),
    /** Null for a top-level comment. */
    parent_comment_id: z.string().nullable(),
    author: ContactSchema.nullable(),
    body: z.string().nullable(),
    like_count: z.number().int().nullable(),
    reply_count: z.number().int().nullable(),
    /** The provider's own timestamp, UTC. */
    posted_at: z.iso.datetime().nullable(),
    /**
     * Ours, not a provider concept. Marks the comment as dealt with, which is what turns a
     * firehose into an inbox somebody can clear.
     */
    handled_at: z.iso.datetime().nullable(),
  })
  .strict();

export const CommentListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(CommentSchema),
    has_more: z.boolean(),
    next_cursor: z.null(),
  })
  .strict();

export const ReplyToCommentRequestSchema = z
  .object({
    body: z.string().min(1).max(5000),
  })
  .strict();

export const ConversationSchema = z
  .object({
    id: z.string(),
    object: z.literal('conversation'),
    provider: ProviderNameSchema,
    destination_id: z.string(),
    contact: ContactSchema.nullable(),
    subject: z.string().nullable(),
    last_message_at: z.iso.datetime().nullable(),
    last_message_preview: z.string().nullable(),
    /** Inbound messages only. Our own replies do not make a thread look more urgent. */
    unread_count: z.number().int(),
  })
  .strict();

export const ConversationListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(ConversationSchema),
    has_more: z.boolean(),
    next_cursor: z.null(),
  })
  .strict();

export const MessageSchema = z
  .object({
    id: z.string(),
    object: z.literal('message'),
    direction: z.enum(['inbound', 'outbound']),
    body: z.string().nullable(),
    sent_at: z.iso.datetime().nullable(),
  })
  .strict();

export const MessageListResponseSchema = z
  .object({
    object: z.literal('list'),
    conversation_id: z.string(),
    data: z.array(MessageSchema),
    has_more: z.boolean(),
    next_cursor: z.null(),
  })
  .strict();

export const SendMessageRequestSchema = z
  .object({
    body: z.string().min(1).max(10000),
  })
  .strict();

export type CommentResponse = z.infer<typeof CommentSchema>;
export type ConversationResponse = z.infer<typeof ConversationSchema>;
