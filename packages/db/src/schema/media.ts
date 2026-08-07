import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { mediaKindEnum, mediaSourceEnum, mediaStatusEnum } from './enums.js';
import { organizations, profiles, projectEnvironments } from './tenancy.js';

/**
 * Media assets and their target-specific variants (plan §31, §32, §33).
 *
 * Phase 1 probes metadata only. Transformation happens in a separate media-processing
 * service (ADR-005) — Workers orchestrate, they do not run FFmpeg. The variant table
 * exists now so that adding auto-fit later is additive, not a schema rewrite (plan P14).
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    status: mediaStatusEnum('status').notNull().default('awaiting_upload'),
    source: mediaSourceEnum('source').notNull().default('upload'),
    kind: mediaKindEnum('kind'),

    /** `org/{org_id}/env/{env_id}/media/{media_id}/original` (plan §31). */
    storageKey: text('storage_key'),
    /** Only for `external_url` sources; validated against SSRF rules (plan §68). */
    externalUrl: text('external_url'),

    filename: text('filename'),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),

    /** Populated by the async probe. NULL until `status = 'ready'`. */
    width: integer('width'),
    height: integer('height'),
    durationSeconds: real('duration_seconds'),
    aspectRatio: real('aspect_ratio'),
    frameRate: real('frame_rate'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    /** NULL until probed. Several providers reject silent video for Reels/Shorts. */
    hasAudio: boolean('has_audio'),

    /** SHA-256 of the bytes. Deduplicates uploads and keys derived variants (plan §33). */
    contentHash: text('content_hash'),

    altText: text('alt_text'),

    probeError: text('probe_error'),
    probedAt: timestamp('probed_at', { withTimezone: true }),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('media_assets_profile_created_idx').on(table.profileId, table.createdAt.desc()),
    index('media_assets_environment_idx').on(table.projectEnvironmentId),
    index('media_assets_content_hash_idx')
      .on(table.projectEnvironmentId, table.contentHash)
      .where(sql`${table.contentHash} IS NOT NULL`),
    /** Sweeps presigned uploads the client never completed. */
    index('media_assets_abandoned_uploads_idx')
      .on(table.uploadExpiresAt)
      .where(sql`${table.status} = 'awaiting_upload'`),
  ],
);

/**
 * A normalized/transcoded derivative of a source asset (plan §33).
 *
 * Keyed by a transformation signature — `sha256(source_hash + transform_spec_version +
 * transform_parameters)` — so one source video published to a Reel, a TikTok, a Short and
 * LinkedIn is transcoded once per distinct target shape, not once per post.
 */
export const mediaVariants = pgTable(
  'media_variants',
  {
    id: uuid('id').primaryKey(),
    mediaAssetId: uuid('media_asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** The dedupe key. Identical transforms of identical sources reuse one row. */
    transformSignature: text('transform_signature').notNull(),
    transformSpecVersion: text('transform_spec_version').notNull(),
    transformParameters: jsonb('transform_parameters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Which provider this variant was produced for, when it is provider-specific. */
    provider: text('provider'),
    purpose: text('purpose'),

    status: mediaStatusEnum('status').notNull().default('probing'),
    storageKey: text('storage_key'),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    durationSeconds: real('duration_seconds'),

    error: text('error'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('media_variants_signature_key').on(table.mediaAssetId, table.transformSignature),
    index('media_variants_asset_idx').on(table.mediaAssetId),
  ],
);

export const mediaAssetsRelations = relations(mediaAssets, ({ one, many }) => ({
  profile: one(profiles, { fields: [mediaAssets.profileId], references: [profiles.id] }),
  variants: many(mediaVariants),
}));

export const mediaVariantsRelations = relations(mediaVariants, ({ one }) => ({
  asset: one(mediaAssets, { fields: [mediaVariants.mediaAssetId], references: [mediaAssets.id] }),
}));

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type MediaVariant = typeof mediaVariants.$inferSelect;
