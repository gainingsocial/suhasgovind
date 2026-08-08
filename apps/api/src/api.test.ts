import { HealthResponseSchema } from '@gs/contracts/http';
import { describe, expect, it } from 'vitest';

import type { Env } from './env.js';
import app from './index.js';
import { REQUEST_ID_HEADER, TRACE_ID_HEADER } from './middleware/request-context.js';

const env: Env = {
  ENVIRONMENT: 'test',
  SERVICE_VERSION: '0.1.0-test',
  LOG_LEVEL: 'silent',
};

// `app.request` is typed as sync-or-async; the await is what normalizes it.
const request = async (path: string, init?: RequestInit): Promise<Response> =>
  await app.request(path, init, env);

describe('health', () => {
  it('answers on both the bare and versioned path', async () => {
    for (const path of ['/health', '/v1/health']) {
      const response = await request(path);
      expect(response.status).toBe(200);

      // Parsing with the contract, not eyeballing fields: if the route and the published
      // schema disagree, this fails.
      const body = HealthResponseSchema.parse(await response.json());
      expect(body.status).toBe('ok');
      expect(body.environment).toBe('test');
      expect(body.version).toBe('0.1.0-test');
    }
  });

  it('reports timestamps as UTC ISO-8601 (Rule 15)', async () => {
    const body = HealthResponseSchema.parse(await (await request('/health')).json());
    expect(body.timestamp).toMatch(/Z$/);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});

describe('request id propagation', () => {
  it('generates ids and echoes them on the response', async () => {
    const response = await request('/health');
    const requestId = response.headers.get(REQUEST_ID_HEADER);

    expect(requestId).toBeTruthy();
    expect(response.headers.get(TRACE_ID_HEADER)).toBeTruthy();

    // The body must quote the same id as the header, or the two are useless together.
    const body = HealthResponseSchema.parse(await response.json());
    expect(body.requestId).toBe(requestId);
  });

  it('adopts a well-formed inbound request id', async () => {
    const response = await request('/health', { headers: { [REQUEST_ID_HEADER]: 'req_abc123' } });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req_abc123');
  });

  it('takes the trace id from traceparent', async () => {
    const traceId = 'a'.repeat(32);
    const response = await request('/health', {
      headers: { traceparent: `00-${traceId}-${'b'.repeat(16)}-01` },
    });
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(traceId);
  });

  it('rejects a malformed inbound id rather than echoing it into logs', async () => {
    for (const hostile of ['has spaces', '"quoted"', 'x'.repeat(200), '']) {
      const response = await request('/health', { headers: { [REQUEST_ID_HEADER]: hostile } });
      expect(response.headers.get(REQUEST_ID_HEADER)).not.toBe(hostile);
      expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_/);
    }
  });
});

describe('errors', () => {
  it('returns the standard envelope for an unknown route', async () => {
    const response = await request('/v1/nope');
    expect(response.status).toBe(404);

    const body = (await response.json()) as {
      error: { code: string; type: string; request_id?: string; requestId?: string };
    };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    // The envelope carries the same id as the header (plan §40).
    const echoed = body.error.request_id ?? body.error.requestId;
    expect(echoed).toBe(response.headers.get(REQUEST_ID_HEADER));
  });
});

describe('openapi', () => {
  it('serves a document describing the health route', async () => {
    const response = await request('/openapi.json');
    expect(response.status).toBe(200);

    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/health']).toBeDefined();
  });
});
