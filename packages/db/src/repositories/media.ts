import { newUuidV7 } from '@gs/contracts/ids';
import { ApiError } from '@gs/errors';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';

import type { Database } from '../client.js';
import { mediaAssets, type MediaAsset } from '../schema/media.js';
import { profiles } from '../schema/tenancy.js';

/**
 * Media repository (plan §31, §76).
 *
 * The lifecycle is `awaiting_upload → uploaded → probing → ready`, and nothing may attach
 * media to a post before `ready`. That is not bureaucracy: until the probe runs, the only
 * thing known about the file is what the client claimed, and preflight validating against
 * a claimed size or duration would approve posts the provider then rejects.
 */

export interface CreateUploadIntentInput {
  organizationId: string;
  projectEnvironmentId: string;
  profileId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  altText: string | null;
  storageKeyFor: (mediaId: string) => string;
  /** After this, the reservation is garbage and the row is swept. */
  uploadExpiresAt: Date;
}

export async function createUploadIntent(
  db: Database,
  input: CreateUploadIntentInput,
): Promise<MediaAsset> {
  const id = newUuidV7();

  const rows = await db
    .insert(mediaAssets)
    .values({
      id,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      status: 'awaiting_upload',
      source: 'upload',
      storageKey: input.storageKeyFor(id),
      filename: input.filename,
      // Recorded as *claimed*. The probe overwrites both, and validation reads the probed
      // values — a client that lies here changes nothing downstream.
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      altText: input.altText,
      uploadExpiresAt: input.uploadExpiresAt,
    })
    .returning();

  const created = rows[0];
  if (!created) throw new ApiError('INTERNAL_ERROR', { message: 'Media insert returned no row.' });
  return created;
}

export async function createExternalMedia(
  db: Database,
  input: {
    organizationId: string;
    projectEnvironmentId: string;
    profileId: string;
    url: string;
    altText: string | null;
  },
): Promise<MediaAsset> {
  const rows = await db
    .insert(mediaAssets)
    .values({
      id: newUuidV7(),
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      // Not `ready`: an external URL still has to be fetched and probed before its
      // dimensions are known, and the SSRF checks in plan §68 run at that point.
      status: 'uploaded',
      source: 'external_url',
      externalUrl: input.url,
      altText: input.altText,
    })
    .returning();

  const created = rows[0];
  if (!created) throw new ApiError('INTERNAL_ERROR', { message: 'Media insert returned no row.' });
  return created;
}

export async function findMediaById(
  db: Database,
  projectEnvironmentId: string,
  mediaId: string,
): Promise<MediaAsset | null> {
  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.id, mediaId),
        eq(mediaAssets.projectEnvironmentId, projectEnvironmentId),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Resolve several media assets for a post, verifying they belong to the environment.
 *
 * One query for the whole set, and the caller compares what came back against what it
 * asked for. Looking each one up separately would make a 10-image carousel ten round
 * trips on the publish path.
 */
export async function findMediaByIds(
  db: Database,
  projectEnvironmentId: string,
  mediaIds: readonly string[],
): Promise<Map<string, MediaAsset>> {
  const result = new Map<string, MediaAsset>();
  if (mediaIds.length === 0) return result;

  const rows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        inArray(mediaAssets.id, [...mediaIds]),
        eq(mediaAssets.projectEnvironmentId, projectEnvironmentId),
        isNull(mediaAssets.deletedAt),
      ),
    );

  for (const row of rows) result.set(row.id, row);
  return result;
}

/**
 * Mark an upload complete.
 *
 * Only transitions from `awaiting_upload`, expressed in the WHERE clause rather than
 * checked first. Two concurrent completions therefore cannot both succeed — the second
 * matches nothing — without needing a transaction or a lock (P4).
 */
export async function markUploaded(
  db: Database,
  projectEnvironmentId: string,
  mediaId: string,
): Promise<MediaAsset | null> {
  const rows = await db
    .update(mediaAssets)
    .set({ status: 'uploaded', updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.id, mediaId),
        eq(mediaAssets.projectEnvironmentId, projectEnvironmentId),
        eq(mediaAssets.status, 'awaiting_upload'),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

export interface ProbeResult {
  kind: 'image' | 'video' | 'audio' | 'document';
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  contentHash: string | null;
}

/** Record probe output and mark the asset usable. */
export async function markProbed(
  db: Database,
  mediaId: string,
  probe: ProbeResult,
): Promise<MediaAsset | null> {
  const rows = await db
    .update(mediaAssets)
    .set({
      status: 'ready',
      kind: probe.kind,
      mimeType: probe.mimeType,
      byteSize: probe.byteSize,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
      // Derived rather than stored by the caller, so it cannot disagree with the
      // dimensions it is supposed to describe.
      aspectRatio: probe.width && probe.height ? probe.width / probe.height : null,
      frameRate: probe.frameRate,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      hasAudio: probe.hasAudio,
      contentHash: probe.contentHash,
      probedAt: new Date(),
      probeError: null,
      updatedAt: new Date(),
    })
    .where(eq(mediaAssets.id, mediaId))
    .returning();

  return rows[0] ?? null;
}

export async function markProbeFailed(
  db: Database,
  mediaId: string,
  reason: string,
): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ status: 'failed', probeError: reason, probedAt: new Date(), updatedAt: new Date() })
    .where(eq(mediaAssets.id, mediaId));
}

export async function softDeleteMedia(
  db: Database,
  projectEnvironmentId: string,
  mediaId: string,
): Promise<boolean> {
  const rows = await db
    .update(mediaAssets)
    .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(mediaAssets.id, mediaId),
        eq(mediaAssets.projectEnvironmentId, projectEnvironmentId),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .returning({ id: mediaAssets.id });

  return rows.length > 0;
}

/**
 * Ownership chain for a media asset (P5).
 *
 * Not environment-filtered, for the same reason as the other ownership resolvers: the
 * caller compares the result against the principal, and filtering here would turn a
 * cross-tenant attempt into a 404 and hide it from the check meant to catch it.
 */
export async function findMediaOwnership(
  db: Database,
  mediaId: string,
): Promise<{
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string;
} | null> {
  const rows = await db
    .select({
      organizationId: mediaAssets.organizationId,
      projectId: profiles.projectId,
      projectEnvironmentId: mediaAssets.projectEnvironmentId,
      profileId: mediaAssets.profileId,
    })
    .from(mediaAssets)
    .innerJoin(profiles, eq(profiles.id, mediaAssets.profileId))
    .where(and(eq(mediaAssets.id, mediaId), isNull(mediaAssets.deletedAt)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Sweep abandoned upload reservations.
 *
 * A client that requests a presigned URL and never uploads leaves a row forever
 * otherwise. Run from the reconciler cron (plan §27).
 */
export async function expireAbandonedUploads(db: Database, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(mediaAssets)
    .set({ status: 'failed', probeError: 'Upload was never completed.', updatedAt: now })
    .where(and(eq(mediaAssets.status, 'awaiting_upload'), lt(mediaAssets.uploadExpiresAt, now)))
    .returning({ id: mediaAssets.id });

  return rows.length;
}
