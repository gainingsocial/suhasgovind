/**
 * Identity introspection contracts (plan §85 Rule 5).
 *
 * `GET /v1/me` answers "what is this key, and what may it do?" — the question every
 * integrator asks first, and the one that makes a scope misconfiguration visible before
 * it shows up as a confusing 403 on a real operation.
 */
import { z } from 'zod';

import { ApiScopeSchema } from '../common/scopes.js';

export const MeRequestSchema = z.object({});

export const MeResponseSchema = z.object({
  /** Public, prefixed id of the presenting key. Never the key itself. */
  api_key_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  /** Which side of the test/live split this key acts on. */
  environment: z.enum(['test', 'live']),
  scopes: z.array(ApiScopeSchema),
  /** Non-null when the key may only act on a single profile (plan §38). */
  restricted_to_profile_id: z.string().nullable(),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
