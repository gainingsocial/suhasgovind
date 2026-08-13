import {
  ContentSourceListResponseSchema,
  ContentSourceSchema,
  CreateContentSourceRequestSchema,
  DeleteContentSourceResponseSchema,
  IngestContentRequestSchema,
  IngestContentResponseSchema,
  ListContentSourcesQuerySchema,
  ListSourceItemsQuerySchema,
  RepurposeRequestSchema,
  SourceItemDetailSchema,
  SourceItemListResponseSchema,
  SourceItemSchema,
  UpdateContentSourceRequestSchema,
  UpsertBrandProfileRequestSchema,
  BrandProfileSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import {
  createContentSource,
  disableContentSource,
  findBrandProfile,
  findContentSource,
  findProfileById,
  findSourceItemDetail,
  ingestSourceVersion,
  listContentSources,
  listSourceItems,
  meter,
  updateContentSource,
  upsertBrandProfile,
  type BrandProfile,
  type ContentSource,
  type SourceItem,
  type SourceItemVersion,
} from '@gs/db';
import {
  UNCONFIGURED_GATEWAY,
  htmlToText,
  scanForInjection,
  splitIntoSpans,
  type ModelGateway,
} from '@gs/domain';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody, parseQuery, requirePathId } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Content sources and ingestion (plan §63G–63I, §63Q).
 *
 * Nothing here calls a model. Ingestion converts, sanitizes, hashes and splits into spans —
 * all of it deterministic, all of it working whether or not a model provider is configured
 * (P19). That separation is deliberate: the expensive, non-deterministic step is
 * `/v1/content/repurpose`, and keeping it out of ingestion means a customer can pipe a feed
 * in today and decide about generation later.
 *
 * The sanitize-then-hash order matters. The hash has to cover the text the model will
 * actually read, not the HTML it arrived as — otherwise two fetches whose markup differs by
 * a tracking parameter look like different content and get re-analyzed and re-drafted for
 * an article nobody changed (§63R).
 */
export const contentSources = new Hono<AppEnv>();
export const contentItems = new Hono<AppEnv>();

/**
 * The model gateway for this request.
 *
 * A single resolution point, so that wiring an adapter in is one change here rather than a
 * search for every call site. Until then it is the unconfigured gateway, which fails with a
 * code the caller can branch on instead of returning plausible-looking empty output
 * (§63R).
 */
function modelGateway(_c: Context<AppEnv>): ModelGateway {
  return UNCONFIGURED_GATEWAY;
}

function serializeSource(row: ContentSource) {
  return ContentSourceSchema.parse({
    id: toPublicId('contentSource', row.id),
    object: 'content_source',
    kind: row.kind,
    profile_id: row.profileId ? toPublicId('profile', row.profileId) : null,
    url: row.url,
    name: row.name,
    automation_mode: row.automationMode,
    last_fetched_at: row.lastFetchedAt?.toISOString() ?? null,
    next_fetch_at: row.nextFetchAt?.toISOString() ?? null,
    disabled_at: row.disabledAt?.toISOString() ?? null,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function serializeItem(row: SourceItem) {
  return SourceItemSchema.parse({
    id: toPublicId('sourceItem', row.id),
    object: 'source_item',
    content_source_id: toPublicId('contentSource', row.contentSourceId),
    external_id: row.externalId,
    url: row.url,
    title: row.title,
    published_at: row.publishedAt?.toISOString() ?? null,
    first_seen_at: row.firstSeenAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  });
}

function serializeVersion(row: SourceItemVersion) {
  return {
    id: toPublicId('sourceItem', row.id),
    object: 'source_item_version' as const,
    content_hash: row.contentHash,
    injection_suspected: row.injectionSuspected,
    span_count: row.spans.length,
    fetched_at: row.fetchedAt.toISOString(),
  };
}

/**
 * Resolve the profile a request names, honouring a profile-restricted key.
 *
 * A restricted key sees one profile whether or not it names one, and naming a different
 * one is forbidden rather than ignored — silently substituting would let a caller believe
 * it had written to a profile it never touched.
 */
async function resolveProfileId(
  c: Context<AppEnv>,
  requested: string | undefined,
): Promise<string | null> {
  const principal = c.get('principal');

  if (!requested) return principal.restrictedToProfileId;

  const resolved = fromPublicId('profile', requested);
  if (!resolved) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  if (principal.restrictedToProfileId && principal.restrictedToProfileId !== resolved) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // P5: ownership is resolved server-side, never inferred from the request naming an id.
  const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, resolved);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  return resolved;
}

// ---- sources ---------------------------------------------------------------

contentSources.post('/', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateContentSourceRequestSchema);

  const profileId = await resolveProfileId(c, body.profile_id);

  const row = await createContentSource(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    profileId,
    kind: body.kind,
    url: body.url ?? null,
    name: body.name ?? null,
    ...(body.automation_mode ? { automationMode: body.automation_mode } : {}),
    metadata: body.metadata,
  });

  return c.json(serializeSource(row), 201);
});

contentSources.get('/', withDatabase(), authenticate(['content:read']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, ListContentSourcesQuerySchema);

  const cursor = query.cursor ? fromPublicId('contentSource', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not valid.', param: 'cursor' });
  }

  const profileId = principal.restrictedToProfileId ?? (query.profile_id
    ? await resolveProfileId(c, query.profile_id)
    : null);

  const rows = await listContentSources(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit + 1,
    ...(cursor ? { cursor } : {}),
    ...(profileId ? { profileId } : {}),
    includeDisabled: query.include_disabled,
  });

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];

  return c.json(
    ContentSourceListResponseSchema.parse({
      object: 'list',
      data: page.map(serializeSource),
      has_more: hasMore,
      next_cursor: hasMore && last ? toPublicId('contentSource', last.id) : null,
    }),
    200,
  );
});

contentSources.patch('/:sourceId', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const sourceId = requirePathId(c, 'contentSource', 'sourceId');
  const body = await parseBody(c, UpdateContentSourceRequestSchema);

  const existing = await findContentSource(c.get('db'), principal.projectEnvironmentId, sourceId);
  if (!existing) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such content source.' });

  const row = await updateContentSource(c.get('db'), principal.projectEnvironmentId, sourceId, {
    ...(body.name !== undefined ? { name: body.name ?? null } : {}),
    ...(body.automation_mode !== undefined ? { automationMode: body.automation_mode } : {}),
    ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
  });

  if (!row) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such content source.' });
  return c.json(serializeSource(row), 200);
});

contentSources.delete('/:sourceId', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const sourceId = requirePathId(c, 'contentSource', 'sourceId');

  const existing = await findContentSource(c.get('db'), principal.projectEnvironmentId, sourceId);
  if (!existing) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such content source.' });

  await disableContentSource(c.get('db'), principal.projectEnvironmentId, sourceId);

  // Disabling an already-disabled source is success, not a conflict: the caller's intent
  // is satisfied either way, and erroring would punish a retry after a dropped response.
  return c.json(
    DeleteContentSourceResponseSchema.parse({
      id: toPublicId('contentSource', sourceId),
      object: 'content_source',
      disabled: true,
    }),
    200,
  );
});

// ---- ingestion -------------------------------------------------------------

/**
 * SHA-256 of the normalized text.
 *
 * Web Crypto rather than a library — it is present in the Workers runtime and every other
 * environment this runs in, and a hash implementation is not something to take a
 * dependency on.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

contentItems.post('/ingest', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, IngestContentRequestSchema);

  const sourceId = fromPublicId('contentSource', body.content_source_id);
  if (!sourceId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`content_source_id` is not a valid content source id.',
      param: 'content_source_id',
    });
  }

  const source = await findContentSource(c.get('db'), principal.projectEnvironmentId, sourceId);
  if (!source) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such content source.' });

  if (source.disabledAt) {
    throw new ApiError('CONFLICTING_STATE', {
      message: 'This content source is disabled. Re-enable it before ingesting into it.',
    });
  }

  if (principal.restrictedToProfileId && source.profileId !== principal.restrictedToProfileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // Sanitize first, then hash. The hash must cover what a model would read, or two fetches
  // whose markup differs by a tracking parameter would look like changed content (§63R).
  const normalized = body.content_format === 'html' ? htmlToText(body.content) : body.content;
  const contentHash = await sha256Hex(normalized);
  const spans = splitIntoSpans(normalized);
  const scan = scanForInjection(normalized);

  const result = await ingestSourceVersion(c.get('db'), {
    contentSourceId: source.id,
    projectEnvironmentId: principal.projectEnvironmentId,
    externalId: body.external_id,
    url: body.url ?? null,
    title: body.title ?? null,
    publishedAt: body.published_at ? new Date(body.published_at) : null,
    contentHash,
    normalizedText: normalized,
    spans: spans.map((span) => ({ id: span.id, text: span.text, start: span.start, end: span.end })),
    injectionSuspected: scan.suspicious,
  });

  // Only new content is metered. Re-reading a feed on a schedule is the normal case and
  // charging for it would make the safe thing expensive.
  if (result.versionIsNew) {
    await meter(c.get('db'), {
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      projectEnvironmentId: principal.projectEnvironmentId,
      metric: 'source_item_processed',
      quantity: 1,
      resourceType: 'source_item_version',
      resourceId: result.version.id,
    });
  }

  return c.json(
    IngestContentResponseSchema.parse({
      object: 'ingest_result',
      item: serializeItem(result.item),
      version: serializeVersion(result.version),
      version_is_new: result.versionIsNew,
    }),
    result.versionIsNew ? 201 : 200,
  );
});

/**
 * Turn a source item into a set of per-network drafts (plan §63L, §63M).
 *
 * This is the one endpoint in the content pipeline that cannot work without a model, so it
 * is the one that reports the gateway being unconfigured. Everything before it — ingestion,
 * sanitization, span splitting — and everything after it — reviewing, editing, publishing a
 * set — runs regardless (P19).
 *
 * Reported as 503 `MODEL_PROVIDER_NOT_CONFIGURED` rather than 501: the capability is built
 * and deployed, it is waiting on a key the platform operator supplies. Rule 14 — fail
 * safely with a useful error rather than returning an empty draft set that would look like
 * a source with nothing worth saying.
 */
contentItems.post('/repurpose', withDatabase(), authenticate(['content:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, RepurposeRequestSchema);

  const itemId = fromPublicId('sourceItem', body.source_item_id);
  if (!itemId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`source_item_id` is not a valid source item id.',
      param: 'source_item_id',
    });
  }

  // Validated before reporting the gateway, so a caller fixing one problem does not
  // discover the next only after supplying an API key.
  const detail = await findSourceItemDetail(c.get('db'), principal.projectEnvironmentId, itemId);
  if (!detail) throw new ApiError('SOURCE_NOT_FOUND', { message: 'No such source item.' });

  if (!detail.latestVersion) {
    throw new ApiError('CONFLICTING_STATE', {
      message: 'This source item has no ingested content yet.',
    });
  }

  await resolveProfileId(c, body.profile_id);

  const gateway = modelGateway(c);
  if (!gateway.configured) {
    throw new ApiError('MODEL_PROVIDER_NOT_CONFIGURED', {
      message:
        'No model provider is configured, so this source cannot be repurposed. Publishing, ' +
        'composing, media auto-fit, analytics and the inbox do not depend on one.',
    });
  }

  // Unreachable until an adapter exists. Left as an explicit throw rather than a silent
  // fallthrough so that wiring one in fails loudly here rather than returning undefined.
  throw new ApiError('NOT_IMPLEMENTED', {
    message: 'A model gateway is configured but the repurposing pipeline is not wired to it yet.',
  });
});

contentItems.get('/items', withDatabase(), authenticate(['content:read']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, ListSourceItemsQuerySchema);

  const cursor = query.cursor ? fromPublicId('sourceItem', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not valid.', param: 'cursor' });
  }

  let contentSourceId: string | undefined;
  if (query.content_source_id) {
    const resolved = fromPublicId('contentSource', query.content_source_id);
    if (!resolved) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`content_source_id` is not valid.',
        param: 'content_source_id',
      });
    }
    // Checked rather than trusted: without this the filter would happily scope to another
    // tenant's source id and return an empty list, which reads as "no items" rather than
    // "not yours".
    const source = await findContentSource(
      c.get('db'),
      principal.projectEnvironmentId,
      resolved,
    );
    if (!source) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such content source.' });
    contentSourceId = resolved;
  }

  const rows = await listSourceItems(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit + 1,
    ...(cursor ? { cursor } : {}),
    ...(contentSourceId ? { contentSourceId } : {}),
  });

  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];

  return c.json(
    SourceItemListResponseSchema.parse({
      object: 'list',
      data: page.map(serializeItem),
      has_more: hasMore,
      next_cursor: hasMore && last ? toPublicId('sourceItem', last.id) : null,
    }),
    200,
  );
});

contentItems.get('/items/:itemId', withDatabase(), authenticate(['content:read']), async (c) => {
  const principal = c.get('principal');
  const itemId = requirePathId(c, 'sourceItem', 'itemId');

  const detail = await findSourceItemDetail(c.get('db'), principal.projectEnvironmentId, itemId);
  if (!detail) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such source item.' });

  return c.json(
    SourceItemDetailSchema.parse({
      ...serializeItem(detail.item),
      latest_version: detail.latestVersion ? serializeVersion(detail.latestVersion) : null,
      extraction: detail.extraction
        ? {
            id: toPublicId('sourceItem', detail.extraction.id),
            object: 'content_extraction',
            content_type: detail.extraction.contentType,
            title: detail.extraction.title,
            one_sentence_summary: detail.extraction.oneSentenceSummary,
            extraction: detail.extraction.extraction,
            model: detail.extraction.model,
            prompt_version: detail.extraction.promptVersion,
            input_truncated: detail.extraction.inputTruncated,
            created_at: detail.extraction.createdAt.toISOString(),
          }
        : null,
      // The spans are returned with the item because a grounding claim cites span ids, and
      // a client that cannot resolve those has been handed a citation it cannot check.
      spans: detail.latestVersion?.spans ?? [],
    }),
    200,
  );
});

// ---- brand profile (plan §63K) --------------------------------------------

/**
 * How a profile speaks, and what it will never say.
 *
 * Mounted under the profile because it is one-to-one with it, not a resource in its own
 * right — a brand profile without a profile is meaningless, and giving it its own id would
 * invite a client to hold a reference that outlives the thing it describes.
 *
 * `banned_phrases` is not advice to a model. It is checked against generated drafts before
 * they are stored, because a prompt is a request and a check is a guarantee — and a brand
 * that has told us it will never make a claim is entitled to that being true rather than
 * likely.
 */
export const brandProfiles = new Hono<AppEnv>();

function serializeBrandProfile(row: BrandProfile) {
  return BrandProfileSchema.parse({
    object: 'brand_profile',
    profile_id: toPublicId('profile', row.profileId),
    tone: row.tone,
    audience: row.audience,
    banned_phrases: row.bannedPhrases,
    required_disclosures: row.requiredDisclosures,
    style_notes: row.styleNotes,
    updated_at: row.updatedAt.toISOString(),
  });
}

brandProfiles.get(
  '/:profileId/brand-profile',
  withDatabase(),
  authenticate(['content:read']),
  async (c) => {
    const principal = c.get('principal');
    const profileId = requirePathId(c, 'profile', 'profileId');

    const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
    if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

    if (principal.restrictedToProfileId && principal.restrictedToProfileId !== profileId) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'This API key is restricted to a different profile.',
      });
    }

    const row = await findBrandProfile(c.get('db'), principal.projectEnvironmentId, profileId);

    // An absent brand profile is an empty one rather than a 404. A profile always has a
    // voice; we may simply not have been told what it is, and making the caller handle
    // two shapes for that would be noise.
    if (!row) {
      return c.json(
        BrandProfileSchema.parse({
          object: 'brand_profile',
          profile_id: toPublicId('profile', profileId),
          tone: null,
          audience: null,
          banned_phrases: [],
          required_disclosures: [],
          style_notes: null,
          updated_at: profile.updatedAt.toISOString(),
        }),
        200,
      );
    }

    return c.json(serializeBrandProfile(row), 200);
  },
);

brandProfiles.put(
  '/:profileId/brand-profile',
  withDatabase(),
  authenticate(['content:write']),
  async (c) => {
    const principal = c.get('principal');
    const profileId = requirePathId(c, 'profile', 'profileId');
    const body = await parseBody(c, UpsertBrandProfileRequestSchema);

    const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
    if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

    if (principal.restrictedToProfileId && principal.restrictedToProfileId !== profileId) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'This API key is restricted to a different profile.',
      });
    }

    // PUT rather than PATCH: a brand profile is small and wholly replaced, and a partial
    // update of `banned_phrases` has no obvious meaning — is an omitted list empty, or
    // unchanged? Replacing the document removes the question.
    const row = await upsertBrandProfile(c.get('db'), {
      profileId,
      projectEnvironmentId: principal.projectEnvironmentId,
      organizationId: principal.organizationId,
      tone: body.tone ?? null,
      audience: body.audience ?? null,
      bannedPhrases: body.banned_phrases,
      requiredDisclosures: body.required_disclosures,
      styleNotes: body.style_notes ?? null,
    });

    return c.json(serializeBrandProfile(row), 200);
  },
);
