import { generateApiKey } from '@gs/crypto';
import { ApiError } from '@gs/errors';
import { beforeEach, describe, expect, it } from 'vitest';

import { authenticateApiKey, extractBearerToken } from './authenticate.js';
import { assertOwnership, requireScopes } from './authorize.js';
import type { AuthenticatedPrincipal } from './principal.js';
import type { ApiKeyRecord, ApiKeyRepository } from './ports.js';

const PEPPER = 'test-pepper-not-a-real-secret';

const TENANT = {
  organizationId: 'org-1',
  projectId: 'prj-1',
  projectEnvironmentId: 'env-1',
};

/** In-memory repository. The point of the port is that this is all a test needs. */
class FakeRepository implements ApiKeyRepository {
  readonly touched: string[] = [];
  private readonly byHash = new Map<string, ApiKeyRecord>();

  add(record: ApiKeyRecord): void {
    this.byHash.set(record.keyHash, record);
  }

  findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    return Promise.resolve(this.byHash.get(keyHash) ?? null);
  }

  touchLastUsed(apiKeyId: string): Promise<void> {
    this.touched.push(apiKeyId);
    return Promise.resolve();
  }
}

async function seed(
  repository: FakeRepository,
  overrides: Partial<ApiKeyRecord> = {},
  environment: 'test' | 'live' = 'live',
): Promise<string> {
  const generated = await generateApiKey(environment, PEPPER);
  repository.add({
    id: 'key-1',
    ...TENANT,
    environment,
    keyHash: generated.hash,
    status: 'active',
    scopes: ['posts:read', 'posts:write'],
    restrictedToProfileId: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });
  return generated.raw;
}

/** Assert the thrown error is an ApiError carrying an exact code. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

describe('extractBearerToken', () => {
  it('reads a bearer token case-insensitively', () => {
    expect(extractBearerToken('Bearer sk_live_abc')).toBe('sk_live_abc');
    expect(extractBearerToken('bearer sk_live_abc')).toBe('sk_live_abc');
  });

  it('rejects anything that is not a bearer scheme', () => {
    // A bare key or Basic auth would mean the same credential travels in several shapes.
    expect(extractBearerToken('sk_live_abc')).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Bearer   ')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe('authenticateApiKey', () => {
  let repository: FakeRepository;

  beforeEach(() => {
    repository = new FakeRepository();
  });

  const auth = (header: string | null, now?: Date): Promise<AuthenticatedPrincipal> =>
    authenticateApiKey(header, {
      repository,
      pepper: PEPPER,
      ...(now ? { now: () => now } : {}),
      defer: (work) => void work,
    });

  it('resolves the tenant entirely from the key', async () => {
    const raw = await seed(repository);
    const principal = await auth(`Bearer ${raw}`);

    expect(principal).toMatchObject({
      apiKeyId: 'key-1',
      ...TENANT,
      environment: 'live',
      restrictedToProfileId: null,
    });
    expect(principal.scopes).toEqual(['posts:read', 'posts:write']);
  });

  it('requires a credential', async () => {
    await expectCode(auth(null), 'AUTHENTICATION_REQUIRED');
    await expectCode(auth(''), 'AUTHENTICATION_REQUIRED');
  });

  it('rejects a structurally invalid key before touching storage', async () => {
    await expectCode(auth('Bearer not-a-key'), 'API_KEY_MALFORMED');
    await expectCode(auth('Bearer sk_live_short'), 'API_KEY_MALFORMED');
  });

  it('gives the same answer for an unknown key as for a bad one', async () => {
    // Distinguishing the two would confirm which keys exist.
    const unknown = await generateApiKey('live', PEPPER);
    await expectCode(auth(`Bearer ${unknown.raw}`), 'API_KEY_INVALID');
  });

  it('rejects a key hashed under a different pepper', async () => {
    const generated = await generateApiKey('live', 'a-different-pepper');
    repository.add({
      id: 'key-1',
      ...TENANT,
      environment: 'live',
      keyHash: generated.hash,
      status: 'active',
      scopes: [],
      restrictedToProfileId: null,
      expiresAt: null,
      revokedAt: null,
    });
    await expectCode(auth(`Bearer ${generated.raw}`), 'API_KEY_INVALID');
  });

  it('rejects revoked keys, by status or by timestamp', async () => {
    const byStatus = await seed(repository, { status: 'revoked' });
    await expectCode(auth(`Bearer ${byStatus}`), 'API_KEY_REVOKED');

    repository = new FakeRepository();
    const byTimestamp = await seed(repository, { revokedAt: new Date('2026-01-01T00:00:00Z') });
    await expectCode(auth(`Bearer ${byTimestamp}`), 'API_KEY_REVOKED');
  });

  it('reports a revoked-and-expired key as revoked', async () => {
    // Revocation is the fact that needs a human decision; expiry is routine.
    const raw = await seed(repository, {
      revokedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    await expectCode(auth(`Bearer ${raw}`, new Date('2026-06-01T00:00:00Z')), 'API_KEY_REVOKED');
  });

  it('rejects an expired key and accepts one that has not expired yet', async () => {
    const expiresAt = new Date('2026-06-01T00:00:00Z');

    const raw = await seed(repository, { expiresAt });
    await expectCode(auth(`Bearer ${raw}`, new Date('2026-06-02T00:00:00Z')), 'API_KEY_EXPIRED');

    repository = new FakeRepository();
    const live = await seed(repository, { expiresAt });
    await expect(auth(`Bearer ${live}`, new Date('2026-05-31T00:00:00Z'))).resolves.toBeDefined();
  });

  it('refuses a key whose prefix and stored environment disagree', async () => {
    // A test key that resolved to a live row would reach live data.
    const raw = await seed(repository, { environment: 'test' }, 'live');
    await expectCode(auth(`Bearer ${raw}`), 'API_KEY_INVALID');
  });

  it('records last use without blocking the caller', async () => {
    const raw = await seed(repository);
    await auth(`Bearer ${raw}`);
    expect(repository.touched).toEqual(['key-1']);
  });

  it('skips the last-used write when no deferral sink is supplied', async () => {
    const raw = await seed(repository);
    await authenticateApiKey(`Bearer ${raw}`, { repository, pepper: PEPPER });
    expect(repository.touched).toEqual([]);
  });

  it('never puts the raw key on the error', async () => {
    const raw = await seed(repository, { status: 'revoked' });
    const error = await expectCode(auth(`Bearer ${raw}`), 'API_KEY_REVOKED');
    expect(JSON.stringify(error.toEnvelope({ requestId: 'req_1', traceId: 'trc_1' }))).not.toContain(
      raw,
    );
  });
});

describe('requireScopes', () => {
  const principal: AuthenticatedPrincipal = {
    apiKeyId: 'key-1',
    ...TENANT,
    environment: 'live',
    scopes: ['posts:read', 'media:write'],
    restrictedToProfileId: null,
  };

  it('passes when every required scope is granted', () => {
    expect(() => requireScopes(principal, ['posts:read'])).not.toThrow();
    expect(() => requireScopes(principal, ['posts:read', 'media:write'])).not.toThrow();
    expect(() => requireScopes(principal, [])).not.toThrow();
  });

  it('names the missing scopes', () => {
    try {
      requireScopes(principal, ['posts:read', 'posts:write', 'webhooks:manage']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('INSUFFICIENT_SCOPE');
      expect((error as ApiError).message).toContain('posts:write');
      expect((error as ApiError).message).toContain('webhooks:manage');
      expect((error as ApiError).message).not.toContain('posts:read');
    }
  });

  it('does not let a write scope imply its read counterpart', () => {
    const writer: AuthenticatedPrincipal = { ...principal, scopes: ['posts:write'] };
    expect(() => requireScopes(writer, ['posts:read'])).toThrow(ApiError);
  });
});

describe('assertOwnership', () => {
  const principal: AuthenticatedPrincipal = {
    apiKeyId: 'key-1',
    ...TENANT,
    environment: 'live',
    scopes: ['posts:write'],
    restrictedToProfileId: null,
  };

  it('accepts a resource in the same tenant', () => {
    expect(() => assertOwnership(principal, { ...TENANT })).not.toThrow();
  });

  it.each([
    ['organization', { organizationId: 'org-2' }],
    ['project', { projectId: 'prj-2' }],
    ['environment', { projectEnvironmentId: 'env-2' }],
  ])('rejects a resource from another %s', (_label, override) => {
    try {
      assertOwnership(principal, { ...TENANT, ...override });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('TENANT_FORBIDDEN');
    }
  });

  it('rejects a sibling environment in the same project', () => {
    // The test/live split is the case this exists for.
    expect(() => assertOwnership(principal, { ...TENANT, projectEnvironmentId: 'env-test' })).toThrow(
      ApiError,
    );
  });

  describe('profile-restricted keys', () => {
    const restricted: AuthenticatedPrincipal = { ...principal, restrictedToProfileId: 'pro-1' };

    it('allows its own profile', () => {
      expect(() => assertOwnership(restricted, { ...TENANT, profileId: 'pro-1' })).not.toThrow();
    });

    it('rejects another profile', () => {
      expect(() => assertOwnership(restricted, { ...TENANT, profileId: 'pro-2' })).toThrow(ApiError);
    });

    it('allows project-level resources that hang off no profile', () => {
      expect(() => assertOwnership(restricted, { ...TENANT })).not.toThrow();
      expect(() => assertOwnership(restricted, { ...TENANT, profileId: null })).not.toThrow();
    });
  });

  it('lets an unrestricted key reach any profile in its environment', () => {
    expect(() => assertOwnership(principal, { ...TENANT, profileId: 'pro-9' })).not.toThrow();
  });
});
