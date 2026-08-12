import { describe, expect, it } from 'vitest';

import { GainingSocial, isGainingSocialError, type GainingSocialError } from './index.js';
import { autoPaginate } from './pagination.js';

/**
 * A fetch stand-in that records every call and replays scripted responses.
 *
 * The SDK's whole job is what it does *around* a request — retrying the right failures,
 * reusing one idempotency key, honouring Retry-After — so the tests that matter are the
 * ones that inspect the sequence of calls rather than a single response body.
 */
function mockFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    // `null` rather than `''`: a 204 is a null-body status and `Response` rejects any
    // body at all for one, including an empty string.
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return { impl, calls };
}

function errorBody(overrides: Record<string, unknown> = {}) {
  return {
    error: {
      type: 'api_error',
      code: 'PROVIDER_UNAVAILABLE',
      message: 'The provider is unavailable.',
      retryable: true,
      docs_url: 'https://docs.gainingsocial.com/errors/PROVIDER_UNAVAILABLE',
      request_id: 'req_01',
      trace_id: 'trc_01',
      ...overrides,
    },
  };
}

const client = (fetchImpl: typeof globalThis.fetch, overrides = {}) =>
  new GainingSocial({
    apiKey: 'sk_test_abc',
    baseUrl: 'https://api.example.com',
    fetch: fetchImpl,
    ...overrides,
  });

describe('construction', () => {
  it('refuses an empty API key at the line that made the mistake', () => {
    // Failing on the first request instead would surface the error far from its cause.
    expect(() => new GainingSocial({ apiKey: '' })).toThrow(/API key is required/);
  });

  it('sends the key as a bearer token', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: { object: 'me' } }]);
    await client(impl).identity.me();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_test_abc');
  });

  it('identifies itself, and carries an app name when given one', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: {} }]);
    await client(impl, { appName: 'acme-scheduler' }).identity.me();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('gainingsocial-sdk-js');
    expect(headers['user-agent']).toContain('acme-scheduler');
  });
});

describe('errors', () => {
  it('exposes the whole envelope rather than a message to parse', async () => {
    const { impl } = mockFetch([
      {
        status: 422,
        body: errorBody({
          code: 'TEXT_TOO_LONG',
          retryable: false,
          param: 'content.text',
          agent_action: 'shorten_text',
          provider: 'x',
        }),
      },
    ]);

    const error = await client(impl)
      .posts.get('pst_1')
      .catch((e: unknown) => e);

    expect(isGainingSocialError(error)).toBe(true);
    const typed = error as GainingSocialError;
    // Branch on `code`, never on `message` — this is the contract the SDK exists to expose.
    expect(typed.code).toBe('TEXT_TOO_LONG');
    expect(typed.status).toBe(422);
    expect(typed.retryable).toBe(false);
    expect(typed.param).toBe('content.text');
    expect(typed.agentAction).toBe('shorten_text');
    expect(typed.provider).toBe('x');
    // Always present, so a caller can quote one identifier to support.
    expect(typed.requestId).toBe('req_01');
  });

  it('does not pretend an HTML gateway error is an envelope', async () => {
    const impl = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof globalThis.fetch;

    const error = (await client(impl, { maxRetries: 0 })
      .identity.me()
      .catch((e: unknown) => e)) as GainingSocialError;

    // Inventing a `code` from a proxy's HTML would give the caller something to branch on
    // that means nothing.
    expect(error.code).toBe('UNEXPECTED_RESPONSE');
    expect(error.status).toBe(502);
  });

  it('marks a request that never reached the API as retryable', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    const error = (await client(impl, { maxRetries: 0 })
      .identity.me()
      .catch((e: unknown) => e)) as GainingSocialError;

    // A request that never arrived cannot have had a side effect, so trying again is safe.
    expect(error.code).toBe('CONNECTION_FAILED');
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
  });
});

describe('retries', () => {
  it('retries what the API marks retryable', async () => {
    const { impl, calls } = mockFetch([
      { status: 503, body: errorBody() },
      { status: 200, body: { id: 'pst_1' } },
    ]);

    const post = await client(impl).posts.get('pst_1');
    expect(post).toEqual({ id: 'pst_1' });
    expect(calls).toHaveLength(2);
  });

  it('does not retry what the API marks permanent', async () => {
    const { impl, calls } = mockFetch([
      { status: 409, body: errorBody({ code: 'DUPLICATE_POST', retryable: false }) },
    ]);

    await expect(client(impl).posts.get('pst_1')).rejects.toThrow();
    // The status alone would not distinguish this from a retryable conflict; the taxonomy
    // does, and guessing would republish something that already exists.
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const { impl, calls } = mockFetch([{ status: 503, body: errorBody() }]);

    await expect(client(impl, { maxRetries: 2 }).identity.me()).rejects.toThrow();
    // The first attempt plus two retries.
    expect(calls).toHaveLength(3);
  });

  it('can be told not to retry at all', async () => {
    const { impl, calls } = mockFetch([{ status: 503, body: errorBody() }]);
    await expect(client(impl, { maxRetries: 0 }).identity.me()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('generates a key for post creation, which the API requires', async () => {
    const { impl, calls } = mockFetch([{ status: 202, body: { id: 'pst_1' } }]);

    await client(impl).posts.create({
      profile_id: 'pro_1',
      content: { text: 'hello', media_ids: [] },
      targets: [{ destination_id: 'dst_1' }],
    } as never);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses one key across retries, so a retry cannot become a second post', async () => {
    const { impl, calls } = mockFetch([
      { status: 503, body: errorBody() },
      { status: 202, body: { id: 'pst_1' } },
    ]);

    await client(impl).posts.create({
      profile_id: 'pro_1',
      content: { text: 'hello', media_ids: [] },
      targets: [{ destination_id: 'dst_1' }],
    } as never);

    const first = (calls[0]!.init.headers as Record<string, string>)['idempotency-key'];
    const second = (calls[1]!.init.headers as Record<string, string>)['idempotency-key'];

    // Regenerating per attempt would defeat the entire mechanism — two attempts with two
    // keys are two posts.
    expect(calls).toHaveLength(2);
    expect(first).toBe(second);
  });

  it('prefers a caller-supplied key', async () => {
    const { impl, calls } = mockFetch([{ status: 202, body: { id: 'pst_1' } }]);

    await client(impl).posts.create(
      {
        profile_id: 'pro_1',
        content: { text: 'hello', media_ids: [] },
        targets: [{ destination_id: 'dst_1' }],
      } as never,
      { idempotencyKey: 'job-42' },
    );

    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('job-42');
  });

  it('does not attach a key to a read', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: {} }]);
    await client(impl).posts.get('pst_1');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });
});

describe('pagination', () => {
  it('walks every page and stops when the server says there are no more', async () => {
    const pages = [
      { object: 'list' as const, data: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'b' },
      { object: 'list' as const, data: [{ id: 'c' }], has_more: false, next_cursor: null },
    ];
    let call = 0;

    const seen: string[] = [];
    for await (const item of autoPaginate<{ id: string }>(async () => pages[call++]!)) {
      seen.push(item.id);
    }

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('does not loop forever when a page reports has_more without a cursor', async () => {
    const seen: string[] = [];
    for await (const item of autoPaginate<{ id: string }>(async () => ({
      object: 'list',
      data: [{ id: 'a' }],
      has_more: true,
      next_cursor: null,
    }))) {
      seen.push(item.id);
    }

    // Trusting `has_more` alone would spin indefinitely against a buggy server.
    expect(seen).toEqual(['a']);
  });

  it('passes the cursor forward', async () => {
    const cursors: (string | undefined)[] = [];
    const pages = [
      { object: 'list' as const, data: [{ id: 'a' }], has_more: true, next_cursor: 'a' },
      { object: 'list' as const, data: [{ id: 'b' }], has_more: false, next_cursor: null },
    ];
    let call = 0;

    for await (const _ of autoPaginate<{ id: string }>(async (params) => {
      cursors.push(params.cursor);
      return pages[call++]!;
    })) {
      // Draining the iterator is the point; the assertion is on the cursors below.
    }

    expect(cursors).toEqual([undefined, 'a']);
  });
});

describe('request shape', () => {
  it('builds paths against the configured base URL', async () => {
    const { impl, calls } = mockFetch([{ status: 200, body: {} }]);
    await client(impl).profiles.get('pro_123');
    expect(calls[0]!.url).toBe('https://api.example.com/v1/profiles/pro_123');
  });

  it('serializes list parameters into the query string', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { object: 'list', data: [], has_more: false, next_cursor: null } },
    ]);

    await client(impl).posts.list({ limit: 50, order: 'asc' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('order')).toBe('asc');
  });

  it('omits undefined query parameters rather than sending the string "undefined"', async () => {
    const { impl, calls } = mockFetch([
      { status: 200, body: { object: 'list', data: [], has_more: false, next_cursor: null } },
    ]);

    await client(impl).posts.list({ limit: 10 });
    expect(calls[0]!.url).not.toContain('undefined');
  });

  it('reads an empty body as undefined rather than failing to parse it', async () => {
    // A disconnect returns 204 with no body; parsing '' as JSON would throw.
    const { impl } = mockFetch([{ status: 204 }]);
    await expect(client(impl).connections.disconnect('con_1')).resolves.toBeUndefined();
  });
});
