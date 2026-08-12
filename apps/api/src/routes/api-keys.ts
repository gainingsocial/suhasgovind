import {
  ApiKeyListResponseSchema,
  ApiKeySchema,
  CreateApiKeyRequestSchema,
  CreateApiKeyResponseSchema,
  EnvironmentListResponseSchema,
  EnvironmentSchema,
  RevokeApiKeyResponseSchema,
  UpdateEnvironmentRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isApiScope } from '@gs/contracts/scopes';
import { generateApiKey } from '@gs/crypto';
import {
  createApiKey,
  findMembershipForEnvironment,
  listApiKeys,
  listEnvironmentsForUser,
  revokeApiKey,
  setSimulationMode,
  type ApiKeySummary,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { withDatabase } from '../middleware/database.js';
import { authenticateHuman } from '../middleware/authenticate-human.js';
import { parseBody, requirePathId } from '../lib/request.js';

/**
 * API key management (plan §38, §39).
 *
 * Authenticated by a **human session**, never by an API key. A key that could mint another
 * key turns one leaked credential into permanent self-renewing access that revoking the
 * original does not stop — so the two authentication modes are kept strictly apart, and
 * this is the only route group that uses the human one.
 */
export const apiKeys = new Hono<AppEnv>();
export const environments = new Hono<AppEnv>();

/**
 * Roles permitted to switch an environment between live and simulate.
 *
 * Narrower than key management: a developer may issue themselves a key, but flipping an
 * environment to `simulate` stops every scheduled post in it from reaching a platform, and
 * flipping it back starts them all publishing for real.
 */
const MODE_MANAGING_ROLES = new Set(['owner', 'admin']);

/** Roles permitted to mint credentials. A viewer or analyst may look, not issue. */
const KEY_MANAGING_ROLES = new Set(['owner', 'admin', 'developer']);

function toResponse(row: ApiKeySummary, environment: 'test' | 'live') {
  return ApiKeySchema.parse({
    id: toPublicId('apiKey', row.id),
    object: 'api_key',
    name: row.name,
    // The searchable prefix, never the key. It is enough to recognize a key in a list and
    // useless for authenticating.
    key_prefix: row.keyPrefix,
    environment,
    status: row.status,
    scopes: row.scopes.filter(isApiScope),
    restricted_to_profile_id: row.restrictedToProfileId
      ? toPublicId('profile', row.restrictedToProfileId)
      : null,
    // Rule 15 — UTC ISO-8601.
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

environments.get('/', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const rows = await listEnvironmentsForUser(c.get('db'), user.userId);

  return c.json(
    EnvironmentListResponseSchema.parse({
      object: 'list',
      data: rows.map((row) =>
        EnvironmentSchema.parse({
          id: toPublicId('environment', row.projectEnvironmentId),
          object: 'environment',
          organization_id: toPublicId('organization', row.organizationId),
          project_id: toPublicId('project', row.projectId),
          kind: row.environment,
          mode: row.simulationMode ? 'simulate' : 'live',
          role: row.role,
        }),
      ),
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

/**
 * Switch an environment between live and simulate (plan §49).
 *
 * A human session, and an owner or admin, because it is a blast-radius control in both
 * directions: switching to `simulate` silently stops every scheduled post from reaching a
 * platform, and switching back to `live` starts a queue's worth of them publishing for
 * real. Neither belongs behind an API key that an integration holds.
 *
 * The switch takes effect on work already in flight. The publisher reads the mode per
 * publish rather than trusting what was true when a message was enqueued — a scheduled
 * post's message can be days old, and a switch that only affected future posts would not
 * actually stop anything at the moment someone reaches for it.
 */
environments.patch('/:environmentId', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const environmentId = requirePathId(c, 'environment', 'environmentId');
  const body = await parseBody(c, UpdateEnvironmentRequestSchema);

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  if (!MODE_MANAGING_ROLES.has(membership.role)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: `Your role (${membership.role}) cannot change the execution mode of an environment.`,
    });
  }

  await setSimulationMode(c.get('db'), environmentId, body.mode === 'simulate');

  return c.json(
    EnvironmentSchema.parse({
      id: toPublicId('environment', environmentId),
      object: 'environment',
      organization_id: toPublicId('organization', membership.organizationId),
      project_id: toPublicId('project', membership.projectId),
      kind: membership.environment,
      mode: body.mode,
      role: membership.role,
    }),
    200,
  );
});

apiKeys.post('/', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const body = await parseBody(c, CreateApiKeyRequestSchema);

  const environmentId = fromPublicId('environment', body.environment_id);
  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`environment_id` is not a valid environment id.',
      param: 'environment_id',
    });
  }

  // Membership is resolved from the database against the signed-in person, never taken
  // from the request. A caller naming an organization they do not belong to finds nothing.
  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  if (!KEY_MANAGING_ROLES.has(membership.role)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: `Your role (${membership.role}) cannot create API keys.`,
    });
  }

  if (!c.env.API_KEY_HASH_PEPPER) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'API key creation is not configured: API_KEY_HASH_PEPPER is unset.',
    });
  }

  let restrictedToProfileId: string | null = null;
  if (body.restricted_to_profile_id) {
    restrictedToProfileId = fromPublicId('profile', body.restricted_to_profile_id);
    if (!restrictedToProfileId) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`restricted_to_profile_id` is not a valid profile id.',
        param: 'restricted_to_profile_id',
      });
    }
  }

  // The environment decides the prefix, not the caller. A `sk_live_` key issued against a
  // test environment would be a lie that every later check reads as truth.
  const generated = await generateApiKey(membership.environment, c.env.API_KEY_HASH_PEPPER);

  const created = await createApiKey(c.get('db'), {
    organizationId: membership.organizationId,
    projectId: membership.projectId,
    projectEnvironmentId: membership.projectEnvironmentId,
    name: body.name,
    keyPrefix: generated.prefix,
    // Only the hash is stored (plan §38). The raw value below is the only time it exists
    // outside the caller's memory.
    keyHash: generated.hash,
    scopes: body.scopes,
    restrictedToProfileId,
    expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    createdByUserId: user.userId,
  });

  return c.json(
    CreateApiKeyResponseSchema.parse({
      ...toResponse({ ...created, scopes: [...body.scopes] }, membership.environment),
      key: generated.raw,
    }),
    201,
  );
});

apiKeys.get('/', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const environmentId = fromPublicId('environment', c.req.query('environment_id') ?? '');

  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`environment_id` is required and must be a valid environment id.',
      param: 'environment_id',
    });
  }

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  const rows = await listApiKeys(c.get('db'), environmentId);

  return c.json(
    ApiKeyListResponseSchema.parse({
      object: 'list',
      data: rows.map((row) => toResponse(row, membership.environment)),
      // Keys per environment are a handful, not a stream. A cursor here would be
      // ceremony nobody uses.
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

apiKeys.post('/:keyId/revoke', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const keyId = requirePathId(c, 'apiKey', 'keyId');
  const environmentId = fromPublicId('environment', c.req.query('environment_id') ?? '');

  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`environment_id` is required and must be a valid environment id.',
      param: 'environment_id',
    });
  }

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  if (!KEY_MANAGING_ROLES.has(membership.role)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: `Your role (${membership.role}) cannot revoke API keys.`,
    });
  }

  const revoked = await revokeApiKey(c.get('db'), environmentId, keyId);
  if (!revoked) {
    // Either it does not exist here, or it was already revoked. Both mean "there is no
    // active key by that id in this environment", which is what the caller wanted.
    throw new ApiError('RESOURCE_NOT_FOUND', {
      message: 'No active API key with that id in this environment.',
    });
  }

  return c.json(
    RevokeApiKeyResponseSchema.parse({
      id: toPublicId('apiKey', keyId),
      object: 'api_key',
      status: 'revoked',
      revoked_at: new Date().toISOString(),
    }),
    200,
  );
});
