import { MeResponseSchema } from '@gs/contracts/http';
import { toPublicId } from '@gs/contracts/ids';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';

/**
 * Key introspection (plan §38).
 *
 * Requires no scope beyond a valid key: a key is always permitted to describe itself, and
 * requiring a scope here would mean a misconfigured key could not discover why it is
 * misconfigured.
 */
export const me = new Hono<AppEnv>();

me.get('/', authenticate(), (c) => {
  const principal = c.get('principal');

  const body = MeResponseSchema.parse({
    // Internal ids are UUIDv7; the public surface only ever sees the prefixed form.
    api_key_id: toPublicId('apiKey', principal.apiKeyId),
    organization_id: toPublicId('organization', principal.organizationId),
    project_id: toPublicId('project', principal.projectId),
    environment_id: toPublicId('environment', principal.projectEnvironmentId),
    environment: principal.environment,
    scopes: [...principal.scopes],
    restricted_to_profile_id: principal.restrictedToProfileId
      ? toPublicId('profile', principal.restrictedToProfileId)
      : null,
  });

  return c.json(body, 200);
});
