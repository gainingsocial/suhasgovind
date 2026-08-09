import { z } from 'zod';

import { ApiScopeSchema } from '../common/scopes.js';

/**
 * API key management (plan §38, §39).
 *
 * These routes are authenticated by a *human session*, not by an API key. A key cannot
 * mint another key — that would turn a single leaked key into permanent, self-renewing
 * access that revoking the original does not stop.
 */

export const ApiKeySchema = z.object({
  id: z.string(),
  object: z.literal('api_key'),
  name: z.string(),
  /** Searchable prefix, e.g. `sk_test_a1B2c3D4`. Never the full key. */
  key_prefix: z.string(),
  environment: z.enum(['test', 'live']),
  status: z.enum(['active', 'revoked', 'expired']),
  scopes: z.array(ApiScopeSchema),
  restricted_to_profile_id: z.string().nullable(),
  last_used_at: z.iso.datetime().nullable(),
  expires_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});

export const CreateApiKeyRequestSchema = z.object({
  /** The environment the key acts on. Determines whether it can touch live accounts. */
  environment_id: z.string(),
  name: z.string().min(1).max(120),
  /**
   * Least privilege by default: an empty array grants nothing, so a caller must state
   * what the key is for. Defaulting to every scope would make the safe choice the
   * effortful one.
   */
  scopes: z.array(ApiScopeSchema).min(1),
  /** Restricts the key to one profile (plan §38). Useful for per-customer keys. */
  restricted_to_profile_id: z.string().nullish(),
  expires_at: z.iso.datetime().nullish(),
});

/**
 * The only response that ever contains the key itself.
 *
 * Keys are stored hashed under a pepper, so this value is genuinely unrecoverable
 * afterwards — not merely hidden.
 */
export const CreateApiKeyResponseSchema = ApiKeySchema.extend({
  key: z.string().describe('Shown once. Store it now; it cannot be retrieved later.'),
});

export const ApiKeyListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(ApiKeySchema),
  has_more: z.literal(false),
  next_cursor: z.null(),
});

export const RevokeApiKeyResponseSchema = z.object({
  id: z.string(),
  object: z.literal('api_key'),
  status: z.literal('revoked'),
  revoked_at: z.iso.datetime(),
});

/** `GET /v1/environments` — the dashboard's project switcher. */
export const EnvironmentSchema = z.object({
  id: z.string(),
  object: z.literal('environment'),
  organization_id: z.string(),
  project_id: z.string(),
  kind: z.enum(['test', 'live']),
  /** The signed-in person's role in the owning organization. */
  role: z.string(),
});

export const EnvironmentListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(EnvironmentSchema),
  has_more: z.literal(false),
  next_cursor: z.null(),
});
