import { newUuidV7 } from '@gs/contracts/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createPostWithTargets, findOverdueScheduledPosts } from './posts.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';

/**
 * The reconciler is the only thing that makes "scheduled" mean anything (plan §27), so
 * its input query gets its own test. A scheduled post that this misses never publishes
 * and nothing surfaces it — the worst failure mode in the product.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('findOverdueScheduledPosts', () => {
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

  const seed = async (publishAt: Date, status: 'scheduled' | 'queued' = 'scheduled') => {
    const created = await createPostWithTargets(db, {
      profileId: h.tenantA.profileId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      projectId: h.tenantA.projectId,
      organizationId: h.tenantA.organizationId,
      content: { text: 'scheduled', media_ids: [] },
      publishAt,
      status,
      targets: [
        {
          destinationId: h.tenantA.destinationId,
          connectionId: h.tenantA.connectionId,
          provider: 'mock',
          contentFingerprint: newUuidV7(),
          status: 'scheduled',
        },
      ],
    });
    return created.post.id;
  };

  it('finds a post whose publish time has passed', async () => {
    const postId = await seed(new Date(Date.now() - 5 * 60_000));

    const overdue = await findOverdueScheduledPosts(db, { limit: 100 });
    expect(overdue.map((p) => p.id)).toContain(postId);
  });

  it('does not find a post whose publish time is still ahead', async () => {
    const postId = await seed(new Date(Date.now() + 60 * 60_000));

    const overdue = await findOverdueScheduledPosts(db, { limit: 100 });
    expect(overdue.map((p) => p.id)).not.toContain(postId);
  });
});
