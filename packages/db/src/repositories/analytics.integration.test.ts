import { planFreshness } from '@gs/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import {
  findLatestSnapshot,
  findPostsDueForRefresh,
  listExternalPosts,
  listSnapshots,
  markExternalPostDeleted,
  recordAnalyticsSnapshot,
  summarizeProfileAnalytics,
  upsertExternalPost,
} from './analytics.js';

/**
 * Analytics persistence (plan Phase 6).
 *
 * The properties that need a real database: discovery is at-least-once and must not
 * double-count, snapshots accumulate rather than overwrite, and totals come from the latest
 * reading of each post rather than from summing every reading ever taken.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('analytics', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  const discover = (externalPostId: string, overrides: Record<string, unknown> = {}) =>
    upsertExternalPost(db, {
      destinationId: h.tenantA.destinationId,
      profileId: h.tenantA.profileId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      organizationId: h.tenantA.organizationId,
      provider: 'mock',
      externalPostId,
      publishedAt: new Date(),
      ...overrides,
    });

  describe('discovering posts', () => {
    it('records a post seen on a platform', async () => {
      const result = await discover(`ext-${crypto.randomUUID()}`);
      expect(result.created).toBe(true);
    });

    it('does not duplicate a post a second sync sees again', async () => {
      // Discovery re-reads a window overlapping the last one, so the same post arrives
      // repeatedly. Without the upsert every engagement figure would be counted per sync.
      const externalId = `ext-${crypto.randomUUID()}`;

      const first = await discover(externalId);
      const second = await discover(externalId);

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('never severs the link back to the post that created it', async () => {
      // A later discovery pass finds the same post without knowing we published it. If that
      // cleared post_target_id, a published post would silently become "posted elsewhere".
      const externalId = `ext-${crypto.randomUUID()}`;

      await discover(externalId, { postTargetId: null });
      const withLink = await discover(externalId, { postTargetId: null });

      expect(withLink.created).toBe(false);
    });

    it('keeps a published date once one is known', async () => {
      const externalId = `ext-${crypto.randomUUID()}`;
      const published = new Date('2026-01-01T00:00:00Z');

      await discover(externalId, { publishedAt: published });
      await discover(externalId, { publishedAt: null });

      const posts = await listExternalPosts(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        limit: 100,
      });

      const found = posts.find((post) => post.externalPostId === externalId);
      expect(found?.publishedAt?.toISOString()).toBe(published.toISOString());
    });

    it('hides a post the platform no longer shows', async () => {
      // A chart including deleted posts reports engagement nobody can go and look at.
      const externalId = `ext-${crypto.randomUUID()}`;
      const { id } = await discover(externalId);

      await markExternalPostDeleted(db, id);

      const posts = await listExternalPosts(db, {
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        limit: 100,
      });

      expect(posts.map((post) => post.externalPostId)).not.toContain(externalId);
    });

    it('never shows one tenant’s posts to another', async () => {
      const externalId = `ext-${crypto.randomUUID()}`;
      await discover(externalId);

      const theirs = await listExternalPosts(db, {
        projectEnvironmentId: h.tenantB.projectEnvironmentId,
        limit: 100,
      });

      expect(theirs.map((post) => post.externalPostId)).not.toContain(externalId);
    });
  });

  describe('snapshots', () => {
    it('accumulates readings rather than overwriting', async () => {
      // Engagement is a curve, not a number. Overwriting yesterday's figure makes "did it
      // keep gaining views after day two" unanswerable.
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 10, impressions: 100 },
        observedAt: new Date(Date.now() - 3_600_000),
      });

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 42, impressions: 900 },
      });

      const series = await listSnapshots(db, id, 10);
      expect(series).toHaveLength(2);

      const latest = await findLatestSnapshot(db, id);
      expect(latest?.likes).toBe(42);
    });

    it('preserves a downward revision', async () => {
      // Providers really do revise figures down. Hiding it would contradict the platform's
      // own dashboard, which the customer can also see.
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { impressions: 1_000 },
        observedAt: new Date(Date.now() - 3_600_000),
      });

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { impressions: 900 },
      });

      expect((await findLatestSnapshot(db, id))?.impressions).toBe(900);
    });

    it('keeps native metrics the normalized model has no home for', async () => {
      // A model that drops what it does not recognize quietly loses the metric a
      // customer's whole strategy depends on.
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 1 },
        nativeMetrics: { mock: { sticker_taps: 17 } },
      });

      expect((await findLatestSnapshot(db, id))?.nativeMetrics).toEqual({
        mock: { sticker_taps: 17 },
      });
    });

    it('records the three timestamps separately', async () => {
      // Collapsing them is how a customer concludes their post got no engagement when in
      // truth nobody has looked yet.
      const { id } = await discover(`ext-${crypto.randomUUID()}`);
      const asOf = new Date(Date.now() - 7_200_000);
      const plan = planFreshness({ publishedAt: new Date(), lastObservedAt: null });

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 1 },
        providerDataAsOf: asOf,
        nextExpectedRefresh: plan.nextRefreshAt,
      });

      const snapshot = await findLatestSnapshot(db, id);
      expect(snapshot?.providerDataAsOf?.toISOString()).toBe(asOf.toISOString());
      expect(snapshot?.nextExpectedRefresh).not.toBeNull();
      expect(snapshot?.observedAt.getTime()).toBeGreaterThan(asOf.getTime());
    });
  });

  describe('the refresh queue', () => {
    it('puts a never-observed post first', async () => {
      // It is the one nobody has looked at, so it is genuinely the most urgent — and a
      // query that only knows how to find stale rows would miss it entirely.
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      const due = await findPostsDueForRefresh(db, 100);
      expect(due.map((post) => post.id)).toContain(id);
    });

    it('leaves a post alone until its refresh is due', async () => {
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 1 },
        nextExpectedRefresh: new Date(Date.now() + 86_400_000),
      });

      const due = await findPostsDueForRefresh(db, 100);
      expect(due.map((post) => post.id)).not.toContain(id);
    });

    it('picks a post back up once its refresh time passes', async () => {
      const { id } = await discover(`ext-${crypto.randomUUID()}`);

      await recordAnalyticsSnapshot(db, {
        externalPostId: id,
        destinationId: h.tenantA.destinationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        provider: 'mock',
        metrics: { likes: 1 },
        nextExpectedRefresh: new Date(Date.now() - 1_000),
      });

      const due = await findPostsDueForRefresh(db, 100);
      expect(due.map((post) => post.id)).toContain(id);
    });
  });

  describe('totals', () => {
    it('counts each post once, not once per reading', async () => {
      // Summing the whole series would turn a post observed twenty times into twenty
      // posts' worth of impressions.
      const fresh = await createTenantHarness([]);
      const freshHandle = createDatabaseHandle({ connectionString: fresh.connectionString, max: 2 });

      try {
        const { id } = await upsertExternalPost(freshHandle.db, {
          destinationId: fresh.tenantA.destinationId,
          profileId: fresh.tenantA.profileId,
          projectEnvironmentId: fresh.tenantA.projectEnvironmentId,
          organizationId: fresh.tenantA.organizationId,
          provider: 'mock',
          externalPostId: 'only-post',
          publishedAt: new Date(),
        });

        for (const [offset, impressions] of [
          [3_600_000, 100],
          [1_800_000, 500],
          [0, 900],
        ] as const) {
          await recordAnalyticsSnapshot(freshHandle.db, {
            externalPostId: id,
            destinationId: fresh.tenantA.destinationId,
            projectEnvironmentId: fresh.tenantA.projectEnvironmentId,
            provider: 'mock',
            metrics: { impressions, engagements: impressions / 10 },
            observedAt: new Date(Date.now() - offset),
          });
        }

        const totals = await summarizeProfileAnalytics(freshHandle.db, {
          projectEnvironmentId: fresh.tenantA.projectEnvironmentId,
        });

        expect(totals.posts).toBe(1);
        expect(totals.impressions).toBe(900);
        expect(totals.engagements).toBe(90);
      } finally {
        await freshHandle.close();
        await fresh.cleanup();
      }
    });

    it('reports null rather than zero when nothing has been observed', async () => {
      // A total of 0 and "no data yet" look identical on a dashboard and mean opposite
      // things.
      const fresh = await createTenantHarness([]);
      const freshHandle = createDatabaseHandle({ connectionString: fresh.connectionString, max: 2 });

      try {
        const totals = await summarizeProfileAnalytics(freshHandle.db, {
          projectEnvironmentId: fresh.tenantA.projectEnvironmentId,
        });

        expect(totals.posts).toBe(0);
        expect(totals.impressions).toBeNull();
      } finally {
        await freshHandle.close();
        await fresh.cleanup();
      }
    });
  });
});
