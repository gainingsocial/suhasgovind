import { newUuidV7 } from '@gs/contracts/ids';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import {
  brandProfiles,
  contentExtractions,
  contentSources,
  draftGroundingClaims,
  llmRuns,
  socialDraftSets,
  socialDrafts,
  sourceItemVersions,
  sourceItems,
  type AutomationMode,
  type BrandProfile,
  type ContentExtraction,
  type ContentSource,
  type ContentSourceKind,
  type DraftSetStatus,
  type SocialDraft,
  type SocialDraftSet,
  type SourceItem,
  type SourceItemVersion,
} from '../schema/content.js';

/**
 * Content Intelligence repository (plan §63F–63Q, §76).
 *
 * Domain operations, not CRUD. The two that carry the design are `ingestSourceVersion` and
 * `createDraftSet`:
 *
 * `ingestSourceVersion` is idempotent on content, not on time. Re-reading a feed hourly
 * returns identical text, and the unique index on `(source_item_id, content_hash)` is what
 * turns the second read into a no-op rather than a fresh version, a fresh extraction and a
 * fresh set of drafts for something nobody republished (§63R). It reports whether the
 * version was new so the caller can skip the model call rather than pay for it again.
 *
 * `createDraftSet` writes the set, its drafts and their grounding claims in one
 * transaction. A draft that exists without its claims would read as ungrounded content
 * that nobody had checked, which is precisely the state P18 exists to make impossible.
 */

// ---- sources ---------------------------------------------------------------

export interface CreateContentSourceInput {
  projectEnvironmentId: string;
  organizationId: string;
  profileId?: string | null;
  kind: ContentSourceKind;
  url?: string | null;
  name?: string | null;
  automationMode?: AutomationMode;
  nextFetchAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function createContentSource(
  db: Database,
  input: CreateContentSourceInput,
): Promise<ContentSource> {
  const rows = await db
    .insert(contentSources)
    .values({
      id: newUuidV7(),
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      profileId: input.profileId ?? null,
      kind: input.kind,
      url: input.url ?? null,
      name: input.name ?? null,
      // Not defaulted here on purpose — the column default is `approval_required`, and
      // leaving it to the database means no code path can accidentally create a source
      // that publishes without review (P20).
      ...(input.automationMode ? { automationMode: input.automationMode } : {}),
      nextFetchAt: input.nextFetchAt ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();

  return rows[0]!;
}

export interface ListContentSourcesInput {
  projectEnvironmentId: string;
  limit: number;
  cursor?: string;
  profileId?: string;
  includeDisabled?: boolean;
}

export async function listContentSources(
  db: Database,
  input: ListContentSourcesInput,
): Promise<ContentSource[]> {
  const conditions = [eq(contentSources.projectEnvironmentId, input.projectEnvironmentId)];
  if (input.profileId) conditions.push(eq(contentSources.profileId, input.profileId));
  if (!input.includeDisabled) conditions.push(isNull(contentSources.disabledAt));
  // Ids are UUIDv7, so id ordering is creation ordering and the cursor needs no second key.
  if (input.cursor) conditions.push(lt(contentSources.id, input.cursor));

  return db
    .select()
    .from(contentSources)
    .where(and(...conditions))
    .orderBy(desc(contentSources.id))
    .limit(input.limit);
}

export async function findContentSource(
  db: Database,
  projectEnvironmentId: string,
  contentSourceId: string,
): Promise<ContentSource | null> {
  const rows = await db
    .select()
    .from(contentSources)
    .where(
      and(
        eq(contentSources.id, contentSourceId),
        eq(contentSources.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export interface UpdateContentSourceInput {
  name?: string | null;
  automationMode?: AutomationMode;
  nextFetchAt?: Date | null;
  disabled?: boolean;
  metadata?: Record<string, unknown>;
}

export async function updateContentSource(
  db: Database,
  projectEnvironmentId: string,
  contentSourceId: string,
  input: UpdateContentSourceInput,
): Promise<ContentSource | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.automationMode !== undefined) patch.automationMode = input.automationMode;
  if (input.nextFetchAt !== undefined) patch.nextFetchAt = input.nextFetchAt;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (input.disabled !== undefined) patch.disabledAt = input.disabled ? new Date() : null;

  const rows = await db
    .update(contentSources)
    .set(patch)
    .where(
      and(
        eq(contentSources.id, contentSourceId),
        eq(contentSources.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/**
 * Retire a source.
 *
 * Soft, because its items and their drafts remain meaningful — a post published from an
 * article last month should still be traceable to that article after somebody stops
 * following the feed.
 */
export async function disableContentSource(
  db: Database,
  projectEnvironmentId: string,
  contentSourceId: string,
): Promise<boolean> {
  const rows = await db
    .update(contentSources)
    .set({ disabledAt: new Date(), nextFetchAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(contentSources.id, contentSourceId),
        eq(contentSources.projectEnvironmentId, projectEnvironmentId),
        isNull(contentSources.disabledAt),
      ),
    )
    .returning({ id: contentSources.id });

  return rows.length > 0;
}

// ---- items and versions ----------------------------------------------------

export interface IngestSourceVersionInput {
  contentSourceId: string;
  projectEnvironmentId: string;
  externalId: string;
  url?: string | null;
  title?: string | null;
  publishedAt?: Date | null;
  contentHash: string;
  normalizedText: string;
  spans: { id: string; text: string; start: number; end: number }[];
  injectionSuspected: boolean;
}

export interface IngestSourceVersionResult {
  item: SourceItem;
  version: SourceItemVersion;
  /** False when this exact text was already stored — the caller skips the model call. */
  versionIsNew: boolean;
}

export async function ingestSourceVersion(
  db: Database,
  input: IngestSourceVersionInput,
): Promise<IngestSourceVersionResult> {
  return db.transaction(async (tx) => {
    const itemRows = await tx
      .insert(sourceItems)
      .values({
        id: newUuidV7(),
        contentSourceId: input.contentSourceId,
        projectEnvironmentId: input.projectEnvironmentId,
        externalId: input.externalId,
        url: input.url ?? null,
        title: input.title ?? null,
        publishedAt: input.publishedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [sourceItems.contentSourceId, sourceItems.externalId],
        set: {
          // Kept when the new read does not supply one: a feed that drops a title on one
          // fetch must not erase the title an earlier fetch found.
          url: sql`coalesce(excluded.url, ${sourceItems.url})`,
          title: sql`coalesce(excluded.title, ${sourceItems.title})`,
          publishedAt: sql`coalesce(excluded.published_at, ${sourceItems.publishedAt})`,
          updatedAt: new Date(),
        },
      })
      .returning();

    const item = itemRows[0]!;

    const versionRows = await tx
      .insert(sourceItemVersions)
      .values({
        id: newUuidV7(),
        sourceItemId: item.id,
        contentHash: input.contentHash,
        normalizedText: input.normalizedText,
        spans: input.spans,
        injectionSuspected: input.injectionSuspected,
      })
      .onConflictDoNothing({
        target: [sourceItemVersions.sourceItemId, sourceItemVersions.contentHash],
      })
      .returning();

    if (versionRows[0]) {
      return { item, version: versionRows[0], versionIsNew: true };
    }

    // The conflict path: the identical text is already stored, so return what is there.
    // Nothing about it needs updating — a version is immutable by construction.
    const existing = await tx
      .select()
      .from(sourceItemVersions)
      .where(
        and(
          eq(sourceItemVersions.sourceItemId, item.id),
          eq(sourceItemVersions.contentHash, input.contentHash),
        ),
      )
      .limit(1);

    return { item, version: existing[0]!, versionIsNew: false };
  });
}

export interface ListSourceItemsInput {
  projectEnvironmentId: string;
  limit: number;
  cursor?: string;
  contentSourceId?: string;
}

export async function listSourceItems(
  db: Database,
  input: ListSourceItemsInput,
): Promise<SourceItem[]> {
  const conditions = [eq(sourceItems.projectEnvironmentId, input.projectEnvironmentId)];
  if (input.contentSourceId) conditions.push(eq(sourceItems.contentSourceId, input.contentSourceId));
  if (input.cursor) conditions.push(lt(sourceItems.id, input.cursor));

  return db
    .select()
    .from(sourceItems)
    .where(and(...conditions))
    .orderBy(desc(sourceItems.id))
    .limit(input.limit);
}

export interface SourceItemDetail {
  item: SourceItem;
  latestVersion: SourceItemVersion | null;
  extraction: ContentExtraction | null;
}

/**
 * An item with the version currently in force and whatever was extracted from it.
 *
 * "Currently in force" is the most recently fetched version, not the most recently created
 * row: a re-fetch of older text is still the state of the source as of that fetch.
 */
export async function findSourceItemDetail(
  db: Database,
  projectEnvironmentId: string,
  sourceItemId: string,
): Promise<SourceItemDetail | null> {
  const itemRows = await db
    .select()
    .from(sourceItems)
    .where(
      and(
        eq(sourceItems.id, sourceItemId),
        eq(sourceItems.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  const item = itemRows[0];
  if (!item) return null;

  const versionRows = await db
    .select()
    .from(sourceItemVersions)
    .where(eq(sourceItemVersions.sourceItemId, item.id))
    .orderBy(desc(sourceItemVersions.fetchedAt))
    .limit(1);

  const latestVersion = versionRows[0] ?? null;
  if (!latestVersion) return { item, latestVersion: null, extraction: null };

  const extractionRows = await db
    .select()
    .from(contentExtractions)
    .where(eq(contentExtractions.sourceItemVersionId, latestVersion.id))
    .limit(1);

  return { item, latestVersion, extraction: extractionRows[0] ?? null };
}

/**
 * The spans an extraction read, for verifying a claim that cites them.
 *
 * Joined back through the version rather than stored on the extraction, because the spans
 * belong to the text, not to what a model made of it — and duplicating them would create
 * two copies that could disagree about what the source said.
 */
export async function findSpansForExtraction(
  db: Database,
  projectEnvironmentId: string,
  contentExtractionId: string,
): Promise<{ id: string; text: string; start: number; end: number }[]> {
  const rows = await db
    .select({ spans: sourceItemVersions.spans })
    .from(contentExtractions)
    .innerJoin(
      sourceItemVersions,
      eq(contentExtractions.sourceItemVersionId, sourceItemVersions.id),
    )
    .where(
      and(
        eq(contentExtractions.id, contentExtractionId),
        eq(contentExtractions.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0]?.spans ?? [];
}

export interface RecordExtractionInput {
  sourceItemVersionId: string;
  projectEnvironmentId: string;
  contentType?: string | null;
  title?: string | null;
  oneSentenceSummary?: string | null;
  extraction: Record<string, unknown>;
  model?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputTruncated?: boolean;
}

/**
 * Store what a model understood a version to say.
 *
 * Upsert on the version, because two workers can legitimately race to extract the same
 * newly ingested item and the second result is no less valid than the first.
 */
export async function recordExtraction(
  db: Database,
  input: RecordExtractionInput,
): Promise<ContentExtraction> {
  const rows = await db
    .insert(contentExtractions)
    .values({
      id: newUuidV7(),
      sourceItemVersionId: input.sourceItemVersionId,
      projectEnvironmentId: input.projectEnvironmentId,
      contentType: input.contentType ?? null,
      title: input.title ?? null,
      oneSentenceSummary: input.oneSentenceSummary ?? null,
      extraction: input.extraction,
      model: input.model ?? null,
      modelVersion: input.modelVersion ?? null,
      promptVersion: input.promptVersion ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      inputTruncated: input.inputTruncated ?? false,
    })
    .onConflictDoUpdate({
      target: [contentExtractions.sourceItemVersionId],
      set: {
        contentType: sql`excluded.content_type`,
        title: sql`excluded.title`,
        oneSentenceSummary: sql`excluded.one_sentence_summary`,
        extraction: sql`excluded.extraction`,
        model: sql`excluded.model`,
        modelVersion: sql`excluded.model_version`,
        promptVersion: sql`excluded.prompt_version`,
        inputTokens: sql`excluded.input_tokens`,
        outputTokens: sql`excluded.output_tokens`,
        inputTruncated: sql`excluded.input_truncated`,
      },
    })
    .returning();

  return rows[0]!;
}

// ---- draft sets ------------------------------------------------------------

export interface DraftInput {
  provider: string;
  destinationId?: string | null;
  body: string;
  mediaIds?: string[];
  claims?: {
    claimText: string;
    claimKind?: string;
    sourceSpanIds?: string[];
    verified: boolean;
    failureReason?: string | null;
  }[];
}

export interface CreateDraftSetInput {
  projectEnvironmentId: string;
  organizationId: string;
  profileId: string;
  contentExtractionId?: string | null;
  title?: string | null;
  /**
   * Set by the caller from the grounding result. Never inferred here — the repository does
   * not get to decide whether content was traceable to its source.
   */
  groundingFailed: boolean;
  drafts: DraftInput[];
}

export interface DraftSetDetail {
  set: SocialDraftSet;
  drafts: (SocialDraft & { claims: DraftClaim[] })[];
}

export interface DraftClaim {
  id: string;
  claimText: string;
  claimKind: string;
  sourceSpanIds: string[];
  verified: boolean;
  failureReason: string | null;
}

/**
 * Write a draft set, its drafts and their grounding claims atomically.
 *
 * The status is never passed in: a set always starts as `draft`. P20 says automation
 * defaults to review, and a repository that accepted `status: 'approved'` would turn that
 * principle into something a caller could opt out of.
 */
export async function createDraftSet(
  db: Database,
  input: CreateDraftSetInput,
): Promise<DraftSetDetail> {
  return db.transaction(async (tx) => {
    const setRows = await tx
      .insert(socialDraftSets)
      .values({
        id: newUuidV7(),
        projectEnvironmentId: input.projectEnvironmentId,
        organizationId: input.organizationId,
        profileId: input.profileId,
        contentExtractionId: input.contentExtractionId ?? null,
        title: input.title ?? null,
        groundingFailed: input.groundingFailed,
      })
      .returning();

    const set = setRows[0]!;
    const drafts: (SocialDraft & { claims: DraftClaim[] })[] = [];

    for (const draft of input.drafts) {
      const draftRows = await tx
        .insert(socialDrafts)
        .values({
          id: newUuidV7(),
          draftSetId: set.id,
          destinationId: draft.destinationId ?? null,
          provider: draft.provider,
          body: draft.body,
          mediaIds: draft.mediaIds ?? [],
        })
        .returning();

      const row = draftRows[0]!;
      const claims: DraftClaim[] = [];

      for (const claim of draft.claims ?? []) {
        const claimRows = await tx
          .insert(draftGroundingClaims)
          .values({
            id: newUuidV7(),
            socialDraftId: row.id,
            claimText: claim.claimText,
            claimKind: claim.claimKind ?? 'fact',
            sourceSpanIds: claim.sourceSpanIds ?? [],
            verified: claim.verified,
            failureReason: claim.failureReason ?? null,
          })
          .returning();

        const stored = claimRows[0]!;
        claims.push({
          id: stored.id,
          claimText: stored.claimText,
          claimKind: stored.claimKind,
          sourceSpanIds: stored.sourceSpanIds,
          verified: stored.verified,
          failureReason: stored.failureReason,
        });
      }

      drafts.push({ ...row, claims });
    }

    return { set, drafts };
  });
}

export async function findDraftSetDetail(
  db: Database,
  projectEnvironmentId: string,
  draftSetId: string,
): Promise<DraftSetDetail | null> {
  const setRows = await db
    .select()
    .from(socialDraftSets)
    .where(
      and(
        eq(socialDraftSets.id, draftSetId),
        eq(socialDraftSets.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  const set = setRows[0];
  if (!set) return null;

  const draftRows = await db
    .select()
    .from(socialDrafts)
    .where(eq(socialDrafts.draftSetId, set.id))
    .orderBy(socialDrafts.id);

  const claimRows =
    draftRows.length === 0
      ? []
      : await db
          .select()
          .from(draftGroundingClaims)
          .where(
            sql`${draftGroundingClaims.socialDraftId} IN ${sql.raw(
              `(${draftRows.map((d) => `'${d.id}'`).join(',')})`,
            )}`,
          );

  const byDraft = new Map<string, DraftClaim[]>();
  for (const claim of claimRows) {
    const list = byDraft.get(claim.socialDraftId) ?? [];
    list.push({
      id: claim.id,
      claimText: claim.claimText,
      claimKind: claim.claimKind,
      sourceSpanIds: claim.sourceSpanIds,
      verified: claim.verified,
      failureReason: claim.failureReason,
    });
    byDraft.set(claim.socialDraftId, list);
  }

  return {
    set,
    drafts: draftRows.map((draft) => ({ ...draft, claims: byDraft.get(draft.id) ?? [] })),
  };
}

export interface ListDraftSetsInput {
  projectEnvironmentId: string;
  limit: number;
  cursor?: string;
  profileId?: string;
  status?: DraftSetStatus;
}

export async function listDraftSets(
  db: Database,
  input: ListDraftSetsInput,
): Promise<SocialDraftSet[]> {
  const conditions = [eq(socialDraftSets.projectEnvironmentId, input.projectEnvironmentId)];
  if (input.profileId) conditions.push(eq(socialDraftSets.profileId, input.profileId));
  if (input.status) conditions.push(eq(socialDraftSets.status, input.status));
  if (input.cursor) conditions.push(lt(socialDraftSets.id, input.cursor));

  return db
    .select()
    .from(socialDraftSets)
    .where(and(...conditions))
    .orderBy(desc(socialDraftSets.id))
    .limit(input.limit);
}

/**
 * Edit a draft's body or media.
 *
 * Editing invalidates grounding, and the caller is expected to have re-verified. This
 * takes the recomputed claims rather than leaving stale ones in place, because a claim row
 * that refers to text no longer in the draft is worse than no claim at all — it asserts
 * that something was checked when it was not.
 */
export async function updateDraft(
  db: Database,
  draftId: string,
  input: {
    body?: string;
    mediaIds?: string[];
    claims?: CreateDraftSetInput['drafts'][number]['claims'];
  },
): Promise<SocialDraft | null> {
  return db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.body !== undefined) patch.body = input.body;
    if (input.mediaIds !== undefined) patch.mediaIds = input.mediaIds;

    const rows = await tx
      .update(socialDrafts)
      .set(patch)
      .where(eq(socialDrafts.id, draftId))
      .returning();

    const draft = rows[0];
    if (!draft) return null;

    if (input.claims !== undefined) {
      await tx.delete(draftGroundingClaims).where(eq(draftGroundingClaims.socialDraftId, draftId));
      for (const claim of input.claims) {
        await tx.insert(draftGroundingClaims).values({
          id: newUuidV7(),
          socialDraftId: draftId,
          claimText: claim.claimText,
          claimKind: claim.claimKind ?? 'fact',
          sourceSpanIds: claim.sourceSpanIds ?? [],
          verified: claim.verified,
          failureReason: claim.failureReason ?? null,
        });
      }
    }

    return draft;
  });
}

/**
 * Move a draft set to a new status.
 *
 * Conditional on the status it is expected to be in, so two reviewers approving the same
 * set concurrently produce one transition and one loser who is told why.
 */
export async function transitionDraftSet(
  db: Database,
  projectEnvironmentId: string,
  draftSetId: string,
  from: DraftSetStatus[],
  to: DraftSetStatus,
): Promise<SocialDraftSet | null> {
  const rows = await db
    .update(socialDraftSets)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        eq(socialDraftSets.id, draftSetId),
        eq(socialDraftSets.projectEnvironmentId, projectEnvironmentId),
        sql`${socialDraftSets.status} IN ${sql.raw(`(${from.map((s) => `'${s}'`).join(',')})`)}`,
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/** Link a draft to the post it produced, so provenance survives publishing. */
export async function attachPostToDraft(
  tx: Database | Transaction,
  draftId: string,
  postId: string,
): Promise<void> {
  await tx
    .update(socialDrafts)
    .set({ postId, updatedAt: new Date() })
    .where(eq(socialDrafts.id, draftId));
}

// ---- brand profile ---------------------------------------------------------

export interface UpsertBrandProfileInput {
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  tone?: string | null;
  audience?: string | null;
  bannedPhrases?: string[];
  requiredDisclosures?: string[];
  styleNotes?: string | null;
  metadata?: Record<string, unknown>;
}

export async function upsertBrandProfile(
  db: Database,
  input: UpsertBrandProfileInput,
): Promise<BrandProfile> {
  const rows = await db
    .insert(brandProfiles)
    .values({
      id: newUuidV7(),
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      tone: input.tone ?? null,
      audience: input.audience ?? null,
      bannedPhrases: input.bannedPhrases ?? [],
      requiredDisclosures: input.requiredDisclosures ?? [],
      styleNotes: input.styleNotes ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [brandProfiles.profileId],
      set: {
        tone: sql`excluded.tone`,
        audience: sql`excluded.audience`,
        bannedPhrases: sql`excluded.banned_phrases`,
        requiredDisclosures: sql`excluded.required_disclosures`,
        styleNotes: sql`excluded.style_notes`,
        metadata: sql`excluded.metadata`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return rows[0]!;
}

export async function findBrandProfile(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
): Promise<BrandProfile | null> {
  const rows = await db
    .select()
    .from(brandProfiles)
    .where(
      and(
        eq(brandProfiles.profileId, profileId),
        eq(brandProfiles.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ---- model run accounting --------------------------------------------------

export interface RecordLlmRunInput {
  projectEnvironmentId: string;
  organizationId: string;
  purpose: string;
  model: string;
  modelVersion?: string | null;
  promptVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  outcome: 'succeeded' | 'failed';
  errorCode?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  traceId?: string | null;
}

/**
 * Record a model call, successful or not.
 *
 * Failures are recorded too. A pipeline whose cost ledger only contains successes reports
 * a bill that does not match the invoice, and "it started failing on Tuesday" becomes
 * unanswerable at exactly the moment somebody asks.
 */
export async function recordLlmRun(db: Database, input: RecordLlmRunInput): Promise<void> {
  await db.insert(llmRuns).values({
    id: newUuidV7(),
    projectEnvironmentId: input.projectEnvironmentId,
    organizationId: input.organizationId,
    purpose: input.purpose,
    model: input.model,
    modelVersion: input.modelVersion ?? null,
    promptVersion: input.promptVersion ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    durationMs: input.durationMs ?? null,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    traceId: input.traceId ?? null,
  });
}
