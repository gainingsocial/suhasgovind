import { MeResponseSchema } from '@gs/contracts/http';
import { generateApiKey } from '@gs/crypto';
import { describe, expect, it } from 'vitest';

import type { Env } from './env.js';
import app from './index.js';

/**
 * These exercise the route's configuration and failure paths, which need no database.
 * The authentication logic itself is covered against a fake repository in
 * `packages/auth`; the success path end-to-end needs a live Postgres and is covered by
 * the integration suite once DATABASE_URL exists.
 */

const BASE: Env = {
  ENVIRONMENT: 'test',
  SERVICE_VERSION: '0.1.0-test',
  LOG_LEVEL: 'silent',
};

/** Hono needs an execution context because the middleware uses waitUntil. */
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException() {} };

const request = async (path: string, init?: RequestInit, env: Env = BASE): Promise<Response> =>
  await app.request(path, init, env, ctx as unknown as ExecutionContext);

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe('GET /v1/me', () => {
  const configured: Env = {
    ...BASE,
    API_KEY_HASH_PEPPER: 'test-pepper',
    DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5/postgres',
  };

  it('requires a credential', async () => {
    const response = await request('/v1/me', undefined, configured);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects a non-bearer scheme', async () => {
    const response = await request(
      '/v1/me',
      { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      configured,
    );
    expect(await errorCode(response)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects a structurally invalid key before reaching the database', async () => {
    // The bad connection string in `configured` would fail loudly if this touched it.
    const response = await request(
      '/v1/me',
      { headers: { authorization: 'Bearer nonsense' } },
      configured,
    );
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('API_KEY_MALFORMED');
  });

  it('still propagates the request id on a rejected request', async () => {
    const response = await request('/v1/me', undefined, configured);
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);

    const body = (await response.json()) as { error: { request_id: string } };
    expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
  });

  describe('when the platform is misconfigured', () => {
    it('reports a missing pepper as a server fault, not a caller fault', async () => {
      const response = await request(
        '/v1/me',
        { headers: { authorization: 'Bearer sk_test_x' } },
        { ...BASE, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5/postgres' },
      );
      expect(response.status).toBe(500);
      expect(await errorCode(response)).toBe('INTERNAL_ERROR');
    });

    it('reports a missing database binding the same way', async () => {
      const response = await request(
        '/v1/me',
        { headers: { authorization: 'Bearer sk_test_x' } },
        { ...BASE, API_KEY_HASH_PEPPER: 'test-pepper' },
      );
      expect(response.status).toBe(500);
      expect(await errorCode(response)).toBe('INTERNAL_ERROR');
    });

    it('never leaks the pepper into the response', async () => {
      const pepper = 'super-secret-pepper-value';
      const response = await request(
        '/v1/me',
        { headers: { authorization: 'Bearer sk_test_x' } },
        { ...BASE, API_KEY_HASH_PEPPER: pepper },
      );
      expect(await response.text()).not.toContain(pepper);
    });
  });

  it('never echoes the presented key back to the caller', async () => {
    const generated = await generateApiKey('test', 'test-pepper');
    const response = await request(
      '/v1/me',
      { headers: { authorization: `Bearer ${generated.raw}` } },
      { ...BASE, API_KEY_HASH_PEPPER: 'test-pepper' },
    );
    expect(await response.text()).not.toContain(generated.raw);
  });
});

describe('openapi', () => {
  it('documents /v1/me with its security scheme and error codes', async () => {
    const document = (await (await request('/openapi.json')).json()) as {
      paths: Record<string, { get: { security: unknown[]; responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
    };

    const route = document.paths['/v1/me']?.get;
    expect(route).toBeDefined();
    expect(route?.security).toEqual([{ apiKey: [] }]);

    // Rule 5 — documented error codes, generated from the catalog rather than restated.
    expect(Object.keys(route?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '500']),
    );
    expect(JSON.stringify(route?.responses['401'])).toContain('API_KEY_REVOKED');

    expect(document.components.schemas.Error).toBeDefined();
    expect(document.components.securitySchemes.apiKey).toBeDefined();
  });

  it('describes the response with the same schema the route validates against', async () => {
    const document = (await (await request('/openapi.json')).json()) as {
      paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: { required?: string[] } }> }> } }>;
    };

    const schema = document.paths['/v1/me']?.get.responses['200']?.content['application/json']?.schema;
    const expected = Object.keys(MeResponseSchema.shape);
    expect(schema?.required).toEqual(expect.arrayContaining(expected));
  });
});
