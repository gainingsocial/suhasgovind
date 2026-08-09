import { z } from 'zod';

import { listResponseSchema, PaginationQuerySchema } from '../common/pagination.js';

/**
 * Profile contracts (plan §8.4, §14).
 *
 * A profile is the white-label tenant primitive — the integrator's own customer, brand,
 * location or creator identity. Everything publishable hangs off one, so this is the
 * first object an integrator creates and the one their data model maps onto.
 */

/**
 * IANA timezone. Validated against the runtime's own tz database rather than a regex:
 * a regex accepts `Not/AReal_Zone`, and the failure would then surface much later as a
 * scheduled post firing at the wrong time (plan §27).
 */
const TimezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA timezone identifier, e.g. `America/New_York`.' },
);

/**
 * Customer-supplied metadata, echoed back verbatim.
 *
 * Bounded because it is stored per profile and returned on every read. Unbounded JSON
 * here becomes an unbounded row and an unbounded response body.
 */
const MetadataSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'At most 50 metadata keys.',
  })
  .default({});

export const ProfileSchema = z.object({
  id: z.string(),
  object: z.literal('profile'),
  name: z.string(),
  /** The integrator's own identifier for this profile. Unique per environment. */
  external_id: z.string().nullable(),
  timezone: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  /** Non-null when publishing for this profile is suspended. UTC ISO-8601 (Rule 15). */
  disabled_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileRequestSchema = z.object({
  name: z.string().min(1).max(200),
  /**
   * Optional, but strongly recommended: supplying it makes profile creation naturally
   * idempotent from the integrator's side, since a repeat with the same external_id
   * conflicts rather than silently creating a duplicate customer.
   */
  external_id: z.string().min(1).max(200).nullish(),
  timezone: TimezoneSchema.default('UTC'),
  metadata: MetadataSchema,
});

export type CreateProfileRequest = z.infer<typeof CreateProfileRequestSchema>;

/**
 * PATCH semantics: an absent key leaves the field unchanged, an explicit `null` clears it.
 * `.optional()` and `.nullable()` therefore mean genuinely different things here, and
 * conflating them is how "clear this field" becomes impossible to express.
 */
export const UpdateProfileRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    external_id: z.string().min(1).max(200).nullable().optional(),
    timezone: TimezoneSchema.optional(),
    metadata: z.record(z.string().max(64), z.unknown()).optional(),
    /** `true` suspends publishing for this profile; `false` resumes it. */
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to update.',
  });

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

export const ListProfilesQuerySchema = PaginationQuerySchema.extend({
  /** Exact-match lookup by the integrator's own identifier. */
  external_id: z.string().optional(),
});

export type ListProfilesQuery = z.infer<typeof ListProfilesQuerySchema>;

export const ProfileListResponseSchema = listResponseSchema(ProfileSchema);
export type ProfileListResponse = z.infer<typeof ProfileListResponseSchema>;

/**
 * Deletion is soft and asynchronous-safe: the row is retained for the deletion window so
 * in-flight publishes referencing it can still resolve their tenancy chain. A hard delete
 * would strand queued targets with an unresolvable owner.
 */
export const DeleteProfileResponseSchema = z.object({
  id: z.string(),
  object: z.literal('profile'),
  deleted: z.literal(true),
});
