import {
  DeleteProviderAppResponseSchema,
  ProviderAppListResponseSchema,
  ProviderAppSchema,
  UpsertProviderAppRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  deleteProviderApp,
  findMembershipForEnvironment,
  findProviderAppById,
  listProviderApps,
  upsertProviderApp,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { withDatabase } from '../middleware/database.js';
import { authenticateHuman } from '../middleware/authenticate-human.js';
import { parseBody, requirePathId } from '../lib/request.js';
import { callbackUrlFor, credentialCipher } from '../services/provider-apps.js';

/**
 * Platform application credentials (plan §23).
 *
 * This is the endpoint that makes an approval a data change. When LinkedIn or Meta grants
 * access, the client id and secret are pasted here and that platform starts working — no
 * code edit, no redeploy, no restart. It is the reason every adapter could be written and
 * certified before a single reviewer was involved.
 *
 * Authenticated by a **human dashboard session**, never by an API key, for the same reason
 * `/v1/api-keys` is: a client secret is the key to every connection ever made through that
 * application, so a leaked API key that could write one would be strictly worse than the
 * leak itself.
 */
export const providerApps = new Hono<AppEnv>();

/** Only these roles may write credentials. A developer may look, not paste. */
const CREDENTIAL_MANAGING_ROLES = new Set(['owner', 'admin']);

/**
 * Who may write the *shared* platform application.
 *
 * A platform-managed app authorizes every connection every customer makes through it, so
 * organization membership is nowhere near sufficient authority: an admin of any customer
 * organization could otherwise replace or delete the credential the whole system runs on.
 * The allow-list is an environment secret rather than a database role because it grants
 * authority over the platform itself, and the platform's own configuration is the right
 * place for that — a row granting it would be a row someone could write.
 */
function isPlatformOperator(c: Context<AppEnv>, userId: string): boolean {
  const allowed = (c.env.PLATFORM_OPERATOR_USER_IDS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return allowed.includes(userId);
}

function assertMayWrite(
  c: Context<AppEnv>,
  userId: string,
  role: string,
  ownership: 'customer_managed' | 'platform_managed',
): void {
  if (!CREDENTIAL_MANAGING_ROLES.has(role)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: `Your role (${role}) cannot manage platform credentials.`,
    });
  }

  if (ownership === 'platform_managed' && !isPlatformOperator(c, userId)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message:
        'Only a platform operator can write the shared application. Use `customer_managed` ' +
        'to register your own application for this project.',
      param: 'ownership',
    });
  }
}

function requireEnvironmentId(value: string | undefined): string {
  const environmentId = fromPublicId('environment', value ?? '');
  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`environment_id` is required and must be a valid environment id.',
      param: 'environment_id',
    });
  }
  return environmentId;
}

function apiOrigin(url: string, configured: string | undefined): string {
  return configured ?? new URL(url).origin;
}

providerApps.get('/', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const environmentId = requireEnvironmentId(c.req.query('environment_id'));

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  // Platform-managed applications are shared across every project, so the listing is not
  // project-scoped. Customer-managed ones are, and are merged in below.
  const platform = await listProviderApps(c.get('db'), null);
  const customer = await listProviderApps(c.get('db'), membership.projectId);

  // A project's own application wins over the shared default, which is the same
  // precedence `findProviderApp` applies at call time. Showing both would leave an admin
  // guessing which one actually authorizes their connections.
  const byProvider = new Map(platform.map((row) => [row.provider, row]));
  for (const row of customer) byProvider.set(row.provider, row);

  const origin = apiOrigin(c.req.url, c.env.PUBLIC_API_ORIGIN);

  const data = [...byProvider.values()]
    .filter((row) => isProviderName(row.provider))
    .map((row) =>
      ProviderAppSchema.parse({
        id: toPublicId('event', row.id),
        object: 'provider_app',
        provider: row.provider,
        ownership: row.ownership,
        // The client id is public — it appears in every authorization URL. The secret is
        // not in the row at all: `listProviderApps` projects it away.
        client_id: row.clientId || null,
        configured: Boolean(row.clientId),
        approval_status: row.approvalStatus,
        scopes: row.scopes,
        redirect_uri: isProviderName(row.provider) ? callbackUrlFor(origin, row.provider) : '',
        updated_at: row.updatedAt.toISOString(),
      }),
    );

  return c.json(
    ProviderAppListResponseSchema.parse({
      object: 'list',
      data,
      has_more: false,
      next_cursor: null,
    }),
    200,
  );
});

providerApps.post('/', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const environmentId = requireEnvironmentId(c.req.query('environment_id'));
  const body = await parseBody(c, UpsertProviderAppRequestSchema);

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  assertMayWrite(c, user.userId, membership.role, body.ownership);

  const origin = apiOrigin(c.req.url, c.env.PUBLIC_API_ORIGIN);
  // A shared application belongs to no project; a customer's own is scoped to theirs, and
  // that scoping is what makes it invisible to every other tenant.
  const projectId = body.ownership === 'platform_managed' ? null : membership.projectId;

  const common = {
    provider: body.provider,
    projectId,
    ownership: body.ownership,
    clientId: body.client_id,
    redirectUri: callbackUrlFor(origin, body.provider),
    scopes: body.scopes,
    approvalStatus: body.approval_status,
  };

  // Written twice, deliberately. The credential AAD binds the row id (ADR-007), and the
  // row has no id until it exists — so the record is created first to obtain one, then
  // the secret is encrypted against it and written back. The window in between holds an
  // unusable empty ciphertext, never a plaintext secret.
  const placeholder = await upsertProviderApp(c.get('db'), {
    ...common,
    encryptedClientSecret: { ciphertext: '', nonce: '', algorithm: 'AES-256-GCM', keyVersion: 0 },
  });

  const encrypted = await credentialCipher(c.env).encrypt(body.client_secret, {
    organizationId: placeholder.organizationId ?? 'platform',
    projectId: placeholder.projectId ?? 'platform',
    connectionId: placeholder.id,
    credentialType: 'client_secret',
  });

  const saved = await upsertProviderApp(c.get('db'), {
    ...common,
    encryptedClientSecret: encrypted,
  });

  // The secret is never echoed, not even immediately after being set. An API key is
  // returned once because it cannot be recovered any other way; a client secret can
  // always be re-read from the platform's own console.
  return c.json(
    ProviderAppSchema.parse({
      id: toPublicId('event', saved.id),
      object: 'provider_app',
      provider: body.provider,
      ownership: saved.ownership,
      client_id: saved.clientId,
      configured: true,
      approval_status: saved.approvalStatus,
      scopes: saved.scopes,
      redirect_uri: callbackUrlFor(origin, body.provider),
      updated_at: saved.updatedAt.toISOString(),
    }),
    201,
  );
});

providerApps.delete('/:providerAppId', withDatabase(), authenticateHuman(), async (c) => {
  const user = c.get('user');
  const environmentId = requireEnvironmentId(c.req.query('environment_id'));
  const providerAppId = requirePathId(c, 'event', 'providerAppId');

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  const existing = await findProviderAppById(c.get('db'), providerAppId);
  if (!existing) {
    throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No platform application with that id.' });
  }

  // Ownership is read from the row, never from the request. Deleting the shared
  // application would break connecting for every customer at once, so the authority check
  // has to be against what the row actually is.
  assertMayWrite(c, user.userId, membership.role, existing.ownership);

  if (existing.projectId !== null && existing.projectId !== membership.projectId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'That application belongs to another project.',
    });
  }

  const deleted = await deleteProviderApp(c.get('db'), providerAppId);
  if (!deleted) {
    throw new ApiError('RESOURCE_NOT_FOUND', {
      message: 'No platform application with that id.',
    });
  }

  return c.json(
    DeleteProviderAppResponseSchema.parse({
      id: toPublicId('event', providerAppId),
      object: 'provider_app',
      deleted: true,
    }),
    200,
  );
});
