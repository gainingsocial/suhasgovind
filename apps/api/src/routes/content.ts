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
  createDraftSet,
  disableContentSource,
  findBrandProfile,
  findContentSource,
  findDestinationOwnerships,
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
  ModelGatewayError,
  UNCONFIGURED_GATEWAY,
  htmlToText,
  repurposeSource,
  scanForInjection,
  splitIntoSpans,
  type ModelGateway,
} from '@gs/domain';
import { ApiError } from '@gs/errors';
import { createAnthropicGateway } from '@gs/model-anthropic';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody, parseQuery, requirePathId } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { serializeDraftSet } from './draft-set-serializers.js';
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
 * A single resolution point, so that swapping the model provider is one change here rather
 * than a search for every call site. With no key configured this stays the unconfigured
 * gateway, which fails with a code the caller can branch on instead of returning
 * plausible-looking empty output (§63R).
 *
 * Constructed per request rather than once at module scope: a Worker isolate is reused
 * across requests and across deploys of the *secret*, so caching a client built from an
 * absent key would keep reporting "not configured" after the key was added, until the
 * isolate happened to be recycled.
 */
function modelGateway(c: Context<AppEnv>): ModelGateway {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) return UNCONFIGURED_GATEWAY;

  return createAnthropicGateway({
    apiKey,
    ...(c.env.CONTENT_MODEL ? { model: c.env.CONTENT_MODEL } : {}),
  });
}

interface RepurposeTargetRef {
  publicId: string;
  internalId: string;
  provider: string;
  maxCharacters: number | null;
}

/**
 * Resolve the destinations a repurpose call names, and verify every one belongs to this
 * tenant (P5).
 *
 * Unknown ids and other tenants' ids get the identical answer, for the same reason
 * `POST /v1/posts` does: two different responses for "not yours" is an oracle that lets a
 * caller confirm a guessed id is real by which error it produced.
 */
async function resolveRepurposeTargets(
  c: Context<AppEnv>,
  profileId: string,
  requested: readonly string[],
): Promise<RepurposeTargetRef[]> {
  const principal = c.get('principal');

  const seen = new Set<string>();
  const resolved: { publicId: string; internalId: string }[] = [];

  for (const publicId of requested) {
    const internalId = fromPublicId('destination', publicId);
    if (!internalId) {
      throw new ApiError('INVALID_REQUEST', {
        message: `\`${publicId}\` is not a valid destination id.`,
        param: 'destination_ids',
      });
    }

    // A repeated destination would produce two drafts for one place, which is a duplicate
    // post waiting for somebody to approve both.
    if (seen.has(internalId)) {
      throw new ApiError('DUPLICATE_DESTINATION', {
        message: `Destination ${publicId} appears more than once.`,
        param: 'destination_ids',
      });
    }
    seen.add(internalId);
    resolved.push({ publicId, internalId });
  }

  const ownerships = await findDestinationOwnerships(
    c.get('db'),
    resolved.map((entry) => entry.internalId),
  );

  return resolved.map((entry) => {
    const ownership = ownerships.get(entry.internalId);

    const wrongTenant =
      !ownership ||
      ownership.projectEnvironmentId !== principal.projectEnvironmentId ||
      ownership.projectId !== principal.projectId ||
      ownership.organizationId !== principal.organizationId;

    if (wrongTenant) {
      throw new ApiError('DESTINATION_NOT_FOUND', {
        message: `No such destination (${entry.publicId}).`,
        param: 'destination_ids',
      });
    }

    // Inside the caller's own tenant but on another of their profiles. They are entitled
    // to the real reason — it reveals nothing they could not already list.
    if (ownership.profileId !== profileId) {
      throw new ApiError('INVALID_REQUEST', {
        message: `Destination ${entry.publicId} belongs to a different profile.`,
        param: 'destination_ids',
      });
    }

    // Cached at connect time; null when capability was never resolved, in which case the
    // model simply gets no length hint rather than a fabricated one.
    const limit = ownership.capabilities?.['max_text_length'];

    return {
      publicId: entry.publicId,
      internalId: entry.internalId,
      provider: ownership.provider,
      maxCharacters: typeof limit === 'number' ? limit : null,
    };
  });
}

/**
 * Report a gateway failure in the API's own vocabulary.
 *
 * Each code means something different to a caller: a rate limit is worth retrying, a
 * refusal is not, and an unconfigured provider is an operator problem rather than a
 * request problem. Collapsing them into one 500 would throw away the entire reason the
 * gateway has an error taxonomy.
 */
function asApiError(error: unknown): ApiError {
  if (!(error instanceof ModelGatewayError)) {
    return error instanceof ApiError
      ? error
      : new ApiError('INTERNAL_ERROR', { message: 'Repurposing failed unexpectedly.' });
  }

  switch (error.code) {
    case 'NOT_CONFIGURED':
      return new ApiError('MODEL_PROVIDER_NOT_CONFIGURED', { message: error.message });
    case 'RATE_LIMITED':
      return new ApiError('RATE_LIMITED', { message: error.message });
    case 'TIMEOUT':
    case 'PROVIDER_UNAVAILABLE':
      return new ApiError('PROVIDER_UNAVAILABLE', { message: error.message });
    case 'CONTEXT_TOO_LARGE':
      return new ApiError('INVALID_REQUEST', {
        message: `${error.message} Try a shorter source, or fewer destinations in one call.`,
      });
    case 'CONTENT_FILTERED':
      return new ApiError('MODEL_REFUSED_SOURCE', { message: error.message });
    default:
      return new ApiError('INTERNAL_ERROR', { message: error.message });
  }
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

  /**
   * `profile_id` is required by the contract, so the null case here is unreachable today.
   * Checked rather than asserted because a draft set genuinely cannot exist without a
   * profile — if the contract is ever loosened, this stays a clear 400 instead of becoming
   * a null written into the database.
   */
  const profileId = await resolveProfileId(c, body.profile_id);
  if (!profileId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is required to repurpose a source.',
      param: 'profile_id',
    });
  }

  /**
   * Destinations are resolved and ownership-checked before the model is called (P5).
   *
   * Ordered this way because a model call costs money and time: discovering after it that
   * one of the destinations belongs to somebody else would mean paying for a generation
   * that must then be thrown away. It also keeps the tenant boundary in front of every
   * side effect rather than behind one.
   */
  const targets = await resolveRepurposeTargets(c, profileId, body.destination_ids);

  const gateway = modelGateway(c);
  if (!gateway.configured) {
    throw new ApiError('MODEL_PROVIDER_NOT_CONFIGURED', {
      message:
        'No model provider is configured, so this source cannot be repurposed. Publishing, ' +
        'composing, media auto-fit, analytics and the inbox do not depend on one.',
    });
  }

  let outcome;
  try {
    outcome = await repurposeSource({
      gateway,
      sourceText: detail.latestVersion.normalizedText,
      targets: targets.map((target) => ({
        key: target.publicId,
        provider: target.provider,
        ...(target.maxCharacters !== null ? { maxCharacters: target.maxCharacters } : {}),
      })),
    });
  } catch (error) {
    throw asApiError(error);
  }

  /**
   * The set is written whether or not grounding passed.
   *
   * A failed set is the more useful of the two to keep: it records what the model claimed
   * and which citation could not be traced, which is what a person needs in order to
   * decide whether the source or the model is at fault. `groundingFailed` is what stops it
   * publishing, not its absence from the database.
   */
  const created = await createDraftSet(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    profileId,
    title: detail.item.title ?? null,
    groundingFailed: outcome.groundingFailed,
    drafts: outcome.drafts.map((draft, index) => {
      const target = targets.find((candidate) => candidate.publicId === draft.key)!;
      const grounding = outcome.grounding[index]!;
      const failed = new Set(grounding.failures.map((failure) => failure.claim));

      return {
        destinationId: target.internalId,
        provider: target.provider,
        body: draft.body,
        claims: draft.claims.map((claim) => {
          const failure = grounding.failures.find((entry) => entry.claim === claim.text);
          return {
            claimText: claim.text,
            claimKind: claim.kind,
            sourceSpanIds: [...claim.sourceSpanIds],
            verified: !failed.has(claim.text),
            failureReason: failure?.reason ?? null,
          };
        }),
      };
    }),
  });

  /**
   * Metered against the draft set that resulted, not the source item.
   *
   * One source repurposed for three networks twice is two jobs, not one — and keying the
   * usage row to the set is what makes that distinction survive into billing.
   */
  await meter(c.get('db'), {
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    projectEnvironmentId: principal.projectEnvironmentId,
    metric: 'repurpose_job',
    quantity: 1,
    resourceType: 'draft_set',
    resourceId: created.set.id,
  });

  return c.json(serializeDraftSet(created), 201);
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
