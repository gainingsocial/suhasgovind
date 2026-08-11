import {
  CompleteMediaUploadResponseSchema,
  CreateExternalMediaRequestSchema,
  CreateMediaUploadRequestSchema,
  CreateMediaUploadResponseSchema,
  DeleteMediaResponseSchema,
  MediaPreflightRequestSchema,
  MediaPreflightResponseSchema,
  MediaSchema,
  type Media as MediaResponse,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import {
  createExternalMedia,
  createUploadIntent,
  findDestinationOwnerships,
  findMediaById,
  findProfileById,
  markUploaded,
  softDeleteMedia,
  type MediaAsset,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { mediaStorageKey, presign, type R2Credentials } from '@gs/storage';
import { providerCallContext } from '../lib/provider-context.js';
import { parseBody, requirePathId } from '../lib/request.js';
import { assertSafeMediaUrl } from '../lib/ssrf.js';
import { runPreflight } from '../services/preflight.js';

/**
 * Media (plan §31).
 *
 * Bytes never pass through the Worker. The client gets a presigned URL and PUTs straight
 * to R2 — a 200 MB video through a Worker would exceed both the request-size limit and
 * the CPU budget, and Rule 10 forbids long-running work in the request path anyway.
 */
export const media = new Hono<AppEnv>();

/** Presigned upload window. Long enough for a large file on a poor connection, no longer. */
const UPLOAD_TTL_SECONDS = 3600;

/**
 * Ceiling before a presigned URL is issued at all.
 *
 * Not a substitute for per-provider limits, which are far lower and enforced by preflight.
 * This exists so an obviously-impossible upload is refused before the client spends an
 * hour sending it.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
]);

function toResponse(row: MediaAsset): MediaResponse {
  return MediaSchema.parse({
    id: toPublicId('media', row.id),
    object: 'media',
    profile_id: toPublicId('profile', row.profileId),
    status: row.status,
    source: row.source,
    kind: row.kind,
    filename: row.filename,
    mime_type: row.mimeType,
    byte_size: row.byteSize,
    width: row.width,
    height: row.height,
    duration_seconds: row.durationSeconds,
    aspect_ratio: row.aspectRatio,
    has_audio: row.hasAudio,
    alt_text: row.altText,
    probe_error: row.probeError,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/** R2 configuration, or a precise error saying which piece is missing (Rule 14). */
function r2Credentials(c: Context<AppEnv>): R2Credentials {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = c.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'Media uploads are not configured: R2 credentials are missing.',
    });
  }

  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  };
}

/** Resolve a caller-supplied profile id, enforcing tenancy and key restriction (P5). */
async function resolveOwnedProfile(c: Context<AppEnv>, publicProfileId: string): Promise<string> {
  const principal = c.get('principal');

  const profileId = fromPublicId('profile', publicProfileId);
  if (!profileId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // Existence is checked against the principal's environment, so a profile in another
  // tenant is indistinguishable from one that does not exist.
  const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  return profileId;
}

media.post('/uploads', withDatabase(), authenticate(['media:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateMediaUploadRequestSchema);
  const profileId = await resolveOwnedProfile(c, body.profile_id);

  if (!ALLOWED_UPLOAD_TYPES.has(body.mime_type)) {
    throw new ApiError('MEDIA_TYPE_UNSUPPORTED', {
      message: `\`${body.mime_type}\` cannot be uploaded.`,
      param: 'mime_type',
    });
  }

  if (body.byte_size > MAX_UPLOAD_BYTES) {
    throw new ApiError('MEDIA_TOO_LARGE', {
      message: `Uploads are limited to ${MAX_UPLOAD_BYTES} bytes.`,
      param: 'byte_size',
    });
  }

  const credentials = r2Credentials(c);
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);

  const asset = await createUploadIntent(c.get('db'), {
    organizationId: principal.organizationId,
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
    filename: body.filename,
    mimeType: body.mime_type,
    byteSize: body.byte_size,
    altText: body.alt_text ?? null,
    storageKeyFor: (mediaId) =>
      mediaStorageKey({
        organizationId: principal.organizationId,
        projectEnvironmentId: principal.projectEnvironmentId,
        mediaId,
      }),
    uploadExpiresAt: expiresAt,
  });

  // Content type and length are signed in, so the URL cannot be reused to upload
  // something other than what was declared.
  const presigned = await presign(credentials, {
    method: 'PUT',
    key: asset.storageKey!,
    expiresInSeconds: UPLOAD_TTL_SECONDS,
    contentType: body.mime_type,
    contentLength: body.byte_size,
  });

  return c.json(
    CreateMediaUploadResponseSchema.parse({
      id: toPublicId('media', asset.id),
      object: 'media_upload',
      upload_url: presigned.url,
      upload_headers: presigned.headers,
      upload_method: 'PUT',
      expires_at: presigned.expiresAt,
      media: toResponse(asset),
    }),
    201,
  );
});

media.post('/uploads/:mediaId/complete', withDatabase(), authenticate(['media:write']), async (c) => {
  const principal = c.get('principal');
  const mediaId = requirePathId(c, 'media', 'mediaId');

  const existing = await findMediaById(c.get('db'), principal.projectEnvironmentId, mediaId);
  if (!existing) throw new ApiError('MEDIA_NOT_FOUND');

  if (
    principal.restrictedToProfileId !== null &&
    principal.restrictedToProfileId !== existing.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // Completing twice is not an error. The state transition is expressed in SQL, so the
  // second call simply matches nothing, and returning the current state is what a client
  // retrying after a dropped response needs (P4).
  const updated = await markUploaded(c.get('db'), principal.projectEnvironmentId, mediaId);
  const asset = updated ?? existing;

  if (!updated && existing.status === 'awaiting_upload') {
    // Only reachable if the row changed between the two statements.
    throw new ApiError('CONFLICTING_STATE', {
      message: 'The media asset changed while this request was in flight.',
    });
  }

  // Probing is queued, not performed here (Rule 10). Until it completes the asset is not
  // `ready` and cannot be attached to a post — validating against a client's claimed
  // dimensions would approve posts the provider then rejects.
  if (c.env.MEDIA_QUEUE) {
    c.executionCtx.waitUntil(
      c.env.MEDIA_QUEUE.send({ type: 'media.probe', mediaId, traceId: c.get('trace').traceId }),
    );
  }

  return c.json(CompleteMediaUploadResponseSchema.parse(toResponse(asset)), 200);
});

media.post('/external', withDatabase(), authenticate(['media:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateExternalMediaRequestSchema);
  const profileId = await resolveOwnedProfile(c, body.profile_id);

  // Plan §68 — a caller-supplied URL that we or a provider will fetch is an SSRF vector.
  // Checked at registration so the rejection is immediate and attributable, and again
  // before the fetch, because DNS can change in between.
  assertSafeMediaUrl(body.url);

  const asset = await createExternalMedia(c.get('db'), {
    organizationId: principal.organizationId,
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
    url: body.url,
    altText: body.alt_text ?? null,
  });

  return c.json(toResponse(asset), 201);
});

media.get('/:mediaId', withDatabase(), authenticate(['media:read']), async (c) => {
  const principal = c.get('principal');
  const mediaId = requirePathId(c, 'media', 'mediaId');

  const asset = await findMediaById(c.get('db'), principal.projectEnvironmentId, mediaId);
  if (!asset) throw new ApiError('MEDIA_NOT_FOUND');

  if (
    principal.restrictedToProfileId !== null &&
    principal.restrictedToProfileId !== asset.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return c.json(toResponse(asset), 200);
});

media.delete('/:mediaId', withDatabase(), authenticate(['media:write']), async (c) => {
  const principal = c.get('principal');
  const mediaId = requirePathId(c, 'media', 'mediaId');

  const asset = await findMediaById(c.get('db'), principal.projectEnvironmentId, mediaId);
  if (!asset) throw new ApiError('MEDIA_NOT_FOUND');

  if (
    principal.restrictedToProfileId !== null &&
    principal.restrictedToProfileId !== asset.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  // Soft delete only. A published post's timeline still references the asset, and the
  // R2 object is reaped separately once nothing in flight can need it.
  await softDeleteMedia(c.get('db'), principal.projectEnvironmentId, mediaId);

  return c.json(
    DeleteMediaResponseSchema.parse({
      id: toPublicId('media', mediaId),
      object: 'media',
      deleted: true,
    }),
    200,
  );
});

/**
 * Media preflight (plan §14, §18).
 *
 * Answers "will these assets be accepted on these destinations" without composing a post.
 * The separation earns its place because media is the expensive half: an Instagram
 * rejection on aspect ratio should surface before a 200 MB video is uploaded, not after a
 * post has been composed around it.
 *
 * Runs the same engine `POST /v1/posts/preflight` runs, with no text and no schedule.
 * Reusing it rather than writing a media-only validator is what keeps the two answers
 * consistent — a separate implementation would eventually disagree with the one that
 * decides whether a publish proceeds, and the disagreement would be discovered in
 * production.
 */
media.post('/preflight', withDatabase(), authenticate(['media:read']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, MediaPreflightRequestSchema);

  const destinationIds: string[] = [];
  for (const publicId of body.destination_ids) {
    const internal = fromPublicId('destination', publicId);
    if (!internal) {
      throw new ApiError('INVALID_REQUEST', {
        message: `\`${publicId}\` is not a valid destination id.`,
        param: 'destination_ids',
      });
    }
    destinationIds.push(internal);
  }

  const ownerships = await findDestinationOwnerships(c.get('db'), destinationIds);

  // Every named destination must resolve and belong to this tenant. Silently dropping one
  // would report "valid" for a set the caller never actually checked (P5).
  for (const internalId of destinationIds) {
    const ownership = ownerships.get(internalId);
    if (!ownership) throw new ApiError('DESTINATION_NOT_FOUND');

    if (
      ownership.projectEnvironmentId !== principal.projectEnvironmentId ||
      ownership.projectId !== principal.projectId ||
      ownership.organizationId !== principal.organizationId
    ) {
      throw new ApiError('DESTINATION_NOT_FOUND');
    }

    if (
      principal.restrictedToProfileId !== null &&
      principal.restrictedToProfileId !== ownership.profileId
    ) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'This API key is restricted to a different profile.',
      });
    }
  }

  // Every destination in one call must belong to one profile, because media does too —
  // checking an asset against a destination in another profile is a question with no
  // meaningful answer.
  const profileId = ownerships.get(destinationIds[0]!)!.profileId;

  const outcome = await runPreflight({
    db: c.get('db'),
    context: providerCallContext(c, { timeoutMs: 10_000 }),
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
    // Empty text is not "no text supplied" — it is the honest statement that this check is
    // about the media alone. A platform that requires a caption reports that as a finding,
    // which is correct: the caller has not written one yet.
    content: { text: '', media_ids: body.media_ids, link_url: null },
    targets: destinationIds.map((internalId, index) => ({
      destinationId: internalId,
      publicDestinationId: body.destination_ids[index]!,
      overrides: null,
      options: null,
    })),
    ownerships,
    publishAt: null,
  });

  return c.json(
    MediaPreflightResponseSchema.parse({
      object: 'media_preflight',
      valid: outcome.valid,
      targets: outcome.targets,
    }),
    200,
  );
});
