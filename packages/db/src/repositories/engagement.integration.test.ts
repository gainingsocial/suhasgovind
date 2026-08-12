import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import {
  findConversationById,
  listComments,
  listConversations,
  listMessages,
  markCommentDeleted,
  markCommentHandled,
  markConversationRead,
  recordMessage,
  upsertComment,
  upsertContact,
  upsertConversation,
} from './engagement.js';

/**
 * The unified inbox (plan Phase 7).
 *
 * Every ingest path is at-least-once: a webhook redelivery and a backfill sweep bring the
 * same comment, and they run concurrently by design. These assert that the inbox does not
 * fill with duplicates, that a handled comment stays handled, and that two people working
 * the same queue cannot both reply to one person.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('engagement', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;
  let contactId: string;

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;

    contactId = await upsertContact(db, {
      destinationId: h.tenantA.destinationId,
      profileId: h.tenantA.profileId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      organizationId: h.tenantA.organizationId,
      provider: 'mock',
      externalContactId: 'contact-1',
      displayName: 'Ada Lovelace',
      handle: '@ada',
    });
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  const tenancy = () => ({
    destinationId: h.tenantA.destinationId,
    profileId: h.tenantA.profileId,
    projectEnvironmentId: h.tenantA.projectEnvironmentId,
    organizationId: h.tenantA.organizationId,
    provider: 'mock',
  });

  describe('contacts', () => {
    it('does not create a second contact for the same person', async () => {
      const again = await upsertContact(db, {
        ...tenancy(),
        externalContactId: 'contact-1',
        displayName: 'Ada Lovelace',
      });

      expect(again).toBe(contactId);
    });

    it('does not blank a name a backfill did not return', async () => {
      // A backfill returning only an id must not erase what a webhook already told us.
      await upsertContact(db, { ...tenancy(), externalContactId: 'contact-1', displayName: null });

      const rows = await listComments(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        limit: 1,
      });
      expect(rows).toBeDefined();

      const { findContactById } = await import('./engagement.js');
      expect((await findContactById(db, contactId))?.displayName).toBe('Ada Lovelace');
    });
  });

  describe('comments', () => {
    const comment = (externalCommentId: string, overrides: Record<string, unknown> = {}) =>
      upsertComment(db, {
        ...tenancy(),
        externalCommentId,
        contactId,
        body: 'Great post!',
        postedAt: new Date(),
        ...overrides,
      });

    it('records a comment', async () => {
      const result = await comment(`c-${crypto.randomUUID()}`);
      expect(result.created).toBe(true);
    });

    it('does not duplicate a redelivered comment', async () => {
      const externalId = `c-${crypto.randomUUID()}`;

      const first = await comment(externalId);
      const second = await comment(externalId);

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('keeps a handled comment handled through a redelivery', async () => {
      // Un-handling would put it back at the top of the inbox and invite a second reply to
      // somebody who already got one.
      const externalId = `c-${crypto.randomUUID()}`;
      const { id } = await comment(externalId);

      expect(await markCommentHandled(db, id, 'user_1')).toBe(true);
      await comment(externalId);

      const unhandled = await listComments(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        limit: 100,
      });
      expect(unhandled.map((row) => row.id)).not.toContain(id);
    });

    it('lets exactly one person claim a comment', async () => {
      // Two people working the same inbox is normal, and both replying is a visible,
      // public embarrassment.
      const { id } = await comment(`c-${crypto.randomUUID()}`);

      const [first, second] = await Promise.all([
        markCommentHandled(db, id, 'user_1'),
        markCommentHandled(db, id, 'user_2'),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
    });

    it('hides a comment the platform no longer shows', async () => {
      // It cannot be replied to, so listing it only invites a reply that will fail.
      const { id } = await comment(`c-${crypto.randomUUID()}`);
      await markCommentDeleted(db, id);

      const unhandled = await listComments(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        limit: 100,
      });
      expect(unhandled.map((row) => row.id)).not.toContain(id);
    });

    it('still shows handled comments as history when asked', async () => {
      const { id } = await comment(`c-${crypto.randomUUID()}`);
      await markCommentHandled(db, id, 'user_1');

      const all = await listComments(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        onlyUnhandled: false,
        limit: 100,
      });
      expect(all.map((row) => row.id)).toContain(id);
    });

    it('never shows one tenant’s comments to another', async () => {
      const { id } = await comment(`c-${crypto.randomUUID()}`);

      const theirs = await listComments(db, {
        projectEnvironmentId: h.tenantB.projectEnvironmentId,
        limit: 100,
      });
      expect(theirs.map((row) => row.id)).not.toContain(id);
    });
  });

  describe('conversations', () => {
    async function thread() {
      return upsertConversation(db, {
        ...tenancy(),
        externalThreadId: `t-${crypto.randomUUID()}`,
        contactId,
      });
    }

    it('does not duplicate a thread seen twice', async () => {
      const externalThreadId = `t-${crypto.randomUUID()}`;

      const first = await upsertConversation(db, { ...tenancy(), externalThreadId, contactId });
      const second = await upsertConversation(db, { ...tenancy(), externalThreadId, contactId });

      expect(second).toBe(first);
    });

    it('rolls the summary forward on a new inbound message', async () => {
      const conversationId = await thread();

      await recordMessage(db, {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-1',
        direction: 'inbound',
        body: 'Hello there',
        sentAt: new Date(),
      });

      const conversation = await findConversationById(
        db,
        h.tenantA.projectEnvironmentId,
        conversationId,
      );

      expect(conversation?.lastMessagePreview).toBe('Hello there');
      expect(conversation?.unreadCount).toBe(1);
    });

    it('does not count our own replies as unread', async () => {
      // Answering somebody must not make the thread look more urgent.
      const conversationId = await thread();

      await recordMessage(db, {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-out',
        direction: 'outbound',
        body: 'Thanks for getting in touch',
        sentAt: new Date(),
      });

      const conversation = await findConversationById(
        db,
        h.tenantA.projectEnvironmentId,
        conversationId,
      );
      expect(conversation?.unreadCount).toBe(0);
    });

    it('does not double-count a redelivered message', async () => {
      const conversationId = await thread();
      const message = {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-dup',
        direction: 'inbound' as const,
        body: 'Only once',
        sentAt: new Date(),
      };

      expect((await recordMessage(db, message)).created).toBe(true);
      expect((await recordMessage(db, message)).created).toBe(false);

      const conversation = await findConversationById(
        db,
        h.tenantA.projectEnvironmentId,
        conversationId,
      );
      expect(conversation?.unreadCount).toBe(1);
    });

    it('does not let a backfill rewrite the summary with an older message', async () => {
      // A backfill walking history backwards would otherwise drop an actively-worked
      // thread to the bottom of the inbox.
      const conversationId = await thread();

      await recordMessage(db, {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-new',
        direction: 'inbound',
        body: 'The latest thing',
        sentAt: new Date(),
      });

      await recordMessage(db, {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-old',
        direction: 'inbound',
        body: 'Something from last year',
        sentAt: new Date(Date.now() - 365 * 86_400_000),
      });

      const conversation = await findConversationById(
        db,
        h.tenantA.projectEnvironmentId,
        conversationId,
      );
      expect(conversation?.lastMessagePreview).toBe('The latest thing');
    });

    it('clears the unread count when the thread is read', async () => {
      const conversationId = await thread();

      await recordMessage(db, {
        conversationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        externalMessageId: 'm-read',
        direction: 'inbound',
        body: 'Unread for now',
        sentAt: new Date(),
      });

      await markConversationRead(db, conversationId);

      const conversation = await findConversationById(
        db,
        h.tenantA.projectEnvironmentId,
        conversationId,
      );
      expect(conversation?.unreadCount).toBe(0);
    });

    it('lists messages newest first', async () => {
      const conversationId = await thread();

      for (const [index, offset] of [0, 1, 2].entries()) {
        await recordMessage(db, {
          conversationId,
          projectEnvironmentId: h.tenantA.projectEnvironmentId,
          provider: 'mock',
          externalMessageId: `m-order-${index}`,
          direction: 'inbound',
          body: `message ${index}`,
          sentAt: new Date(Date.now() - offset * 60_000),
        });
      }

      const rows = await listMessages(db, conversationId, 10);
      expect(rows[0]?.body).toBe('message 0');
    });

    it('never shows one tenant’s conversations to another', async () => {
      const conversationId = await thread();

      const theirs = await listConversations(db, {
        projectEnvironmentId: h.tenantB.projectEnvironmentId,
        limit: 100,
      });
      expect(theirs.map((row) => row.id)).not.toContain(conversationId);
    });
  });
});
