import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import {
  CreateProfileRequestSchema,
  DeleteProfileResponseSchema,
  ListProfilesQuerySchema,
  ProfileListResponseSchema,
  ProfileSchema,
  UpdateProfileRequestSchema,
  type Profile as ProfileResponse,
} from '@gs/contracts/http';
import {
  createProfile,
  findProfileById,
  listProfiles,
  softDeleteProfile,
  updateProfile,
  type Profile,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { parseBody, parseQuery, requirePathId } from '../lib/request.js';

/**
 * Profiles (plan §8.4, §14).
 *
 * Every route here is environment-scoped through the principal, so there is no path in
 * which a caller reaches another tenant's profile — the environment id is a query
 * parameter the caller never supplies (P5).
 */
export const profiles = new Hono<AppEnv>();

/** Internal row to public representation. The only place the mapping lives. */
function toResponse(row: Profile): ProfileResponse {
  return ProfileSchema.parse({
    id: toPublicId('profile', row.id),
    object: 'profile',
    name: row.name,
    external_id: row.externalId,
    timezone: row.timezone,
    metadata: row.metadata,
    // Rule 15 — every public timestamp is UTC ISO-8601.
    disabled_at: row.disabledAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

profiles.post('/', withDatabase(), authenticate(['profiles:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateProfileRequestSchema);

  // A profile-restricted key cannot mint new profiles: it would immediately be unable to
  // see what it created, and the grant means "act on this one profile" (plan §38).
  if (principal.restrictedToProfileId !== null) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a single profile and cannot create new ones.',
    });
  }

  const created = await createProfile(c.get('db'), {
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    projectEnvironmentId: principal.projectEnvironmentId,
    name: body.name,
    externalId: body.external_id ?? null,
    timezone: body.timezone,
    metadata: body.metadata,
  });

  return c.json(toResponse(created), 201);
});

profiles.get('/', withDatabase(), authenticate(['profiles:read']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, ListProfilesQuerySchema);

  const cursor = query.cursor ? fromPublicId('profile', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not a valid profile id.' });
  }

  const { rows, hasMore } = await listProfiles(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit,
    order: query.order,
    cursor: cursor ?? undefined,
    externalId: query.external_id,
    restrictedToProfileId: principal.restrictedToProfileId,
  });

  const data = rows.map(toResponse);

  return c.json(
    ProfileListResponseSchema.parse({
      object: 'list',
      data,
      has_more: hasMore,
      next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    }),
    200,
  );
});

profiles.get('/:profileId', withDatabase(), authenticate(['profiles:read']), async (c) => {
  const principal = c.get('principal');
  const profileId = requirePathId(c, 'profile', 'profileId');

  const row = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
  if (!row) throw new ApiError('PROFILE_NOT_FOUND');

  // The environment filter above already guarantees the tenant matches. This second check
  // is the profile-restriction case, which the filter does not cover.
  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== row.id) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return c.json(toResponse(row), 200);
});

profiles.patch('/:profileId', withDatabase(), authenticate(['profiles:write']), async (c) => {
  const principal = c.get('principal');
  const profileId = requirePathId(c, 'profile', 'profileId');
  const body = await parseBody(c, UpdateProfileRequestSchema);

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  const updated = await updateProfile(c.get('db'), principal.projectEnvironmentId, profileId, {
    name: body.name,
    externalId: body.external_id,
    timezone: body.timezone,
    metadata: body.metadata,
    disabled: body.disabled,
  });

  if (!updated) throw new ApiError('PROFILE_NOT_FOUND');
  return c.json(toResponse(updated), 200);
});

profiles.delete('/:profileId', withDatabase(), authenticate(['profiles:write']), async (c) => {
  const principal = c.get('principal');
  const profileId = requirePathId(c, 'profile', 'profileId');

  if (principal.restrictedToProfileId !== null) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a single profile and cannot delete profiles.',
    });
  }

  const deleted = await softDeleteProfile(c.get('db'), principal.projectEnvironmentId, profileId);
  if (!deleted) throw new ApiError('PROFILE_NOT_FOUND');

  return c.json(
    DeleteProfileResponseSchema.parse({
      id: toPublicId('profile', profileId),
      object: 'profile',
      deleted: true,
    }),
    200,
  );
});
