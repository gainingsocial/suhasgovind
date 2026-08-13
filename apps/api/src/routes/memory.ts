import {
  BrandMemoryEntrySchema,
  BrandMemoryListResponseSchema,
  BrandMemoryKindSchema,
  DeleteBrandMemoryResponseSchema,
  LearnRequestSchema,
  LearnResponseSchema,
  PerformanceListResponseSchema,
  RecommendationListResponseSchema,
  UpsertBrandMemoryRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  SETTLING_HOURS,
  deleteBrandMemory,
  findProfileById,
  listBrandMemory,
  listObservations,
  loadPostSamples,
  replaceObservations,
  upsertBrandMemory,
  type BrandMemoryEntry,
  type PerformanceObservationRow,
} from '@gs/db';
import {
  MIN_SAMPLE_SIZE,
  computeObservations,
  usefulRecommendations,
  type PerformanceDimension,
} from '@gs/domain';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody, requirePathId } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Social memory and the optimization loop (plan Phase 10).
 *
 * This is the last step of the loop the plan describes — plan, generate, preflight,
 * publish, observe, normalize, **evaluate, update memory, recommend** — and it is the one
 * that turns a publishing API into something that knows anything.
 *
 * Two things it deliberately does not do.
 *
 * It does not learn automatically on every request. Recomputing is a full scan of a
 * profile's analytics, which is not something to do in a request path (Rule 10) and not
 * something whose cost should be a surprise. `POST /v1/memory/learn` is explicit, and a
 * cron can call it on whatever cadence a customer wants.
 *
 * It does not invent findings. Everything is computed from analytics already collected, no
 * model is involved, and nothing below the minimum sample size is stored or returned.
 * Topic and hook performance are in the plan and are absent, because both need an
 * extraction step and inferring a topic from keyword matching would be a guess presented as
 * a measurement (Rule 14).
 */
export const memory = new Hono<AppEnv>();
export const recommendations = new Hono<AppEnv>();

/** Learning windows are bounded, so a first-time call cannot scan an entire history. */
const DEFAULT_WINDOW_DAYS = 90;

function serializeEntry(row: BrandMemoryEntry) {
  return BrandMemoryEntrySchema.parse({
    id: toPublicId('event', row.id),
    object: 'brand_memory_entry',
    kind: row.kind,
    label: row.label,
    body: row.body,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function serializeObservation(row: PerformanceObservationRow) {
  return {
    object: 'performance_observation' as const,
    provider: isProviderName(row.provider) ? row.provider : 'mock',
    dimension: row.dimension as PerformanceDimension,
    bucket: row.bucket,
    sample_size: row.sampleSize,
    bucket_mean: row.bucketMean,
    baseline_mean: row.baselineMean,
    lift: row.lift,
    metric: row.metric as 'engagement_rate' | 'engagements',
    confidence: row.confidence,
    window_start: row.windowStart.toISOString(),
    window_end: row.windowEnd.toISOString(),
    computed_at: row.computedAt.toISOString(),
  };
}

/**
 * Resolve the profile a memory request is about.
 *
 * Memory is always per profile — a brand's voice and a brand's performance both belong to
 * one identity, and pooling them across a customer's clients would produce advice about
 * nobody in particular.
 */
async function resolveProfile(c: Context<AppEnv>, requested: string | undefined): Promise<string> {
  const principal = c.get('principal');

  const candidate = requested ?? null;
  const resolved = candidate ? fromPublicId('profile', candidate) : principal.restrictedToProfileId;

  if (!resolved) {
    throw new ApiError('MISSING_REQUIRED_FIELD', {
      message: '`profile_id` is required unless the API key is restricted to one profile.',
      param: 'profile_id',
    });
  }

  if (principal.restrictedToProfileId && principal.restrictedToProfileId !== resolved) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // P5: resolved server-side against the key's environment, never trusted from the request.
  const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, resolved);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  return resolved;
}

// ---- brand memory ----------------------------------------------------------

memory.get('/brand', withDatabase(), authenticate(['content:read']), async (c) => {
  const principal = c.get('principal');
  const profileId = await resolveProfile(c, c.req.query('profile_id'));

  // `safeParse` and an explicit throw, not a bare `.parse`. A raw Zod error escapes as an
  // unhandled exception and the caller gets a 500 for what is entirely their typo — the
  // filter is theirs to correct, and a 500 tells them to retry instead.
  const kindParam = c.req.query('kind');
  const parsedKind = kindParam ? BrandMemoryKindSchema.safeParse(kindParam) : undefined;

  if (parsedKind && !parsedKind.success) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`kind` is not a recognized brand memory kind.',
    });
  }

  const kind = parsedKind?.data;

  const rows = await listBrandMemory(
    c.get('db'),
    principal.projectEnvironmentId,
    profileId,
    kind,
  );

  return c.json(
    BrandMemoryListResponseSchema.parse({
      object: 'list',
      data: rows.map(serializeEntry),
      // Brand memory is a handful of facts a person typed, not a feed. Paginating it would
      // add a cursor nobody would ever use.
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

memory.post('/brand', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, UpsertBrandMemoryRequestSchema);
  const profileId = await resolveProfile(c, c.req.query('profile_id'));

  const row = await upsertBrandMemory(c.get('db'), {
    profileId,
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    kind: body.kind,
    label: body.label,
    body: body.body ?? null,
    metadata: body.metadata,
  });

  return c.json(serializeEntry(row), 200);
});

memory.delete('/brand/:entryId', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const entryId = requirePathId(c, 'event', 'entryId');

  /**
   * A hard delete, unlike almost everything else in this system.
   *
   * A customer telling us to forget a competitor means it, and a soft-deleted row a
   * generation step could still read would make the instruction a suggestion.
   */
  const deleted = await deleteBrandMemory(c.get('db'), principal.projectEnvironmentId, entryId);
  if (!deleted) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such memory entry.' });

  return c.json(
    DeleteBrandMemoryResponseSchema.parse({
      id: toPublicId('event', entryId),
      object: 'brand_memory_entry',
      deleted: true,
    }),
    200,
  );
});

// ---- performance memory ----------------------------------------------------

memory.get('/performance', withDatabase(), authenticate(['analytics:read']), async (c) => {
  const principal = c.get('principal');
  const profileId = await resolveProfile(c, c.req.query('profile_id'));

  const rows = await listObservations(c.get('db'), principal.projectEnvironmentId, profileId);

  return c.json(
    PerformanceListResponseSchema.parse({
      object: 'list',
      data: rows.map(serializeObservation),
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

/**
 * Recompute what this profile's analytics say.
 *
 * Explicit rather than automatic. It is a full scan of a profile's published posts and
 * their latest snapshots, which does not belong in the path of a request somebody is
 * waiting on (Rule 10) and should not be a cost that arrives by surprise. Safe to run
 * twice: the result is a function of the data, and the write replaces rather than appends.
 */
memory.post('/learn', withDatabase(), authenticate(['analytics:read', 'content:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, LearnRequestSchema);
  const profileId = await resolveProfile(c, body.profile_id);

  const now = new Date();
  const days = body.days ?? DEFAULT_WINDOW_DAYS;
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  /**
   * Posts younger than this are still accumulating.
   *
   * Including them drags every recent bucket down and produces the confident, wrong
   * conclusion that whatever the customer just started doing is not working.
   */
  const settledBefore = new Date(now.getTime() - SETTLING_HOURS * 60 * 60 * 1000);

  const samples = await loadPostSamples(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
    since: windowStart,
    settledBefore,
  });

  const observations = computeObservations(samples);

  const written = await replaceObservations(c.get('db'), {
    profileId,
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    windowStart,
    windowEnd: settledBefore,
    observations,
  });

  return c.json(
    LearnResponseSchema.parse({
      object: 'learn_result',
      profile_id: toPublicId('profile', profileId),
      samples_considered: samples.length,
      observations_written: written,
      window_start: windowStart.toISOString(),
      window_end: settledBefore.toISOString(),
    }),
    200,
  );
});

// ---- recommendations -------------------------------------------------------

recommendations.get('/', withDatabase(), authenticate(['analytics:read']), async (c) => {
  const principal = c.get('principal');
  const profileId = await resolveProfile(c, c.req.query('profile_id'));

  const rows = await listObservations(c.get('db'), principal.projectEnvironmentId, profileId);

  const advice = usefulRecommendations(
    rows.map((row) => ({
      provider: row.provider,
      dimension: row.dimension as PerformanceDimension,
      bucket: row.bucket,
      sampleSize: row.sampleSize,
      bucketMean: row.bucketMean,
      baselineMean: row.baselineMean,
      lift: row.lift,
      metric: row.metric as 'engagement_rate' | 'engagements',
      confidence: row.confidence,
    })),
  );

  /**
   * An empty list has two very different causes and the caller has to be able to tell.
   *
   * "Nothing has been learned yet" and "everything learned was unremarkable" look
   * identical in an empty array, and a client that renders "no recommendations" for the
   * first case tells a brand-new customer their content is average when in truth nobody
   * has measured it.
   */
  const reason =
    advice.length > 0 ? 'ok' : rows.length === 0 ? 'not_enough_data' : 'nothing_notable';

  return c.json(
    RecommendationListResponseSchema.parse({
      object: 'list',
      data: advice.map((item) => ({
        object: 'recommendation',
        code: item.code,
        provider: isProviderName(item.provider) ? item.provider : 'mock',
        dimension: item.dimension,
        bucket: item.bucket,
        statement: item.statement,
        lift: item.lift,
        sample_size: item.sampleSize,
        confidence: item.confidence,
      })),
      has_more: false,
      next_cursor: null,
      reason,
    }),
    200,
  );
});

/** Exported so the docs can state the threshold rather than describing it vaguely. */
export { MIN_SAMPLE_SIZE };
