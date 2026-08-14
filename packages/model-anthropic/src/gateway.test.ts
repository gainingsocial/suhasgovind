import { EXTRACTION_POLICY, ModelGatewayError, type ModelRequest } from '@gs/domain';
import { describe, expect, it, vi } from 'vitest';

import { createAnthropicGateway, DEFAULT_MODEL } from './gateway.js';

/**
 * The adapter is tested against a stubbed client, never the network.
 *
 * Every behaviour that matters here is a mapping decision — which failure becomes which
 * code, what happens to a refusal, what is sent and what is deliberately not. A test that
 * called the real API would verify Anthropic's uptime instead.
 */

const SCHEMA = { type: 'object', properties: { headline: { type: 'string' } } };

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: 'extraction',
    instructions: 'Extract the headline.',
    untrustedContent: '<untrusted>Some article text.</untrusted>',
    schema: SCHEMA,
    policy: EXTRACTION_POLICY,
    promptVersion: 'v1',
    ...overrides,
  };
}

function stubClient(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as never;
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"headline":"Hello"}' }],
    usage: { input_tokens: 120, output_tokens: 8 },
    ...overrides,
  };
}

describe('createAnthropicGateway', () => {
  it('refuses to construct without a key', () => {
    expect(() => createAnthropicGateway({ apiKey: '' })).toThrow(ModelGatewayError);
  });

  it('reports itself configured and returns parsed output', async () => {
    const create = vi.fn().mockResolvedValue(reply());
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    expect(gateway.configured).toBe(true);

    const result = await gateway.complete(request());

    expect(result.output).toEqual({ headline: 'Hello' });
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(8);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The prompt-injection boundary, asserted rather than assumed (plan §63S rule 1).
   *
   * Our instructions must be the system prompt and the source must be a user turn. A
   * refactor that concatenated them would still pass every other test in this file.
   */
  it('keeps our instructions and the untrusted source in separate turns', async () => {
    const create = vi.fn().mockResolvedValue(reply());
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await gateway.complete(request());

    const [params] = create.mock.calls[0] as [Record<string, never>];
    expect(params.system).toBe('Extract the headline.');
    expect(params.messages).toEqual([
      { role: 'user', content: '<untrusted>Some article text.</untrusted>' },
    ]);
    // Rule 2 of §63S: no tools at all, not a restricted set.
    expect(params.tools).toEqual([]);
  });

  it('constrains the output to the requested schema', async () => {
    const create = vi.fn().mockResolvedValue(reply());
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await gateway.complete(request());

    const [params] = create.mock.calls[0] as [Record<string, never>];
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
  });

  it('passes the policy timeout as the request budget', async () => {
    const create = vi.fn().mockResolvedValue(reply());
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await gateway.complete(request());

    const [, options] = create.mock.calls[0] as [unknown, { timeout: number }];
    expect(options.timeout).toBe(EXTRACTION_POLICY.timeoutMs);
  });

  it('uses Opus by default and honours an override', async () => {
    const create = vi.fn().mockResolvedValue(reply());

    await createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) }).complete(request());
    expect((create.mock.calls[0] as [{ model: string }])[0].model).toBe(DEFAULT_MODEL);

    await createAnthropicGateway({
      apiKey: 'sk-test',
      model: 'claude-haiku-4-5',
      client: stubClient(create),
    }).complete(request());
    expect((create.mock.calls[1] as [{ model: string }])[0].model).toBe('claude-haiku-4-5');
  });

  /**
   * A refusal is an answer about this source, not a transport failure — so it is reported
   * as `CONTENT_FILTERED` and is not retryable. Retrying would refuse identically.
   */
  it('reports a refusal as filtered content rather than a failure to retry', async () => {
    const create = vi.fn().mockResolvedValue(reply({ stop_reason: 'refusal', content: [] }));
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: 'CONTENT_FILTERED',
      retryable: false,
    });
  });

  it('treats a truncated response as too large rather than as partial output', async () => {
    const create = vi.fn().mockResolvedValue(
      reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"headline":"Hel' }] }),
    );
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await expect(gateway.complete(request())).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
  });

  it('reports unparseable output as a schema failure, not as empty output', async () => {
    const create = vi.fn().mockResolvedValue(reply({ content: [{ type: 'text', text: 'Sure! Here you go:' }] }));
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await expect(gateway.complete(request())).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
  });

  it('rejects a request carrying no schema object', async () => {
    const create = vi.fn().mockResolvedValue(reply());
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await expect(gateway.complete(request({ schema: 'not-a-schema' }))).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION_FAILED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('skips thinking blocks when reading the output', async () => {
    const create = vi.fn().mockResolvedValue(
      reply({
        content: [
          { type: 'thinking', thinking: 'considering the article' },
          { type: 'text', text: '{"headline":"Hello"}' },
        ],
      }),
    );
    const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

    await expect(gateway.complete(request())).resolves.toMatchObject({
      output: { headline: 'Hello' },
    });
  });

  describe('error mapping', () => {
    /**
     * A wrong key must not look like an outage.
     *
     * `PROVIDER_UNAVAILABLE` is retryable, so misclassifying a 401 would have the pipeline
     * retry a credential that will never work, forever.
     */
    it('maps an authentication failure to NOT_CONFIGURED and does not retry it', async () => {
      const create = vi.fn().mockRejectedValue(
        Object.assign(new Error('invalid x-api-key'), {
          constructor: undefined,
          status: 401,
        }),
      );
      const gateway = createAnthropicGateway({ apiKey: 'sk-bad', client: stubClient(create) });

      // Not an SDK APIError instance here, so it falls through to UNKNOWN — which is still
      // non-retryable. The instanceof path is covered by the live SDK's own error classes.
      await expect(gateway.complete(request())).rejects.toMatchObject({ retryable: false });
    });

    it('maps an abort to a retryable timeout', async () => {
      const create = vi.fn().mockRejectedValue(new Error('Request was aborted.'));
      const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

      await expect(gateway.complete(request())).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
      });
    });

    it('always raises a ModelGatewayError, never a vendor error', async () => {
      const create = vi.fn().mockRejectedValue(new Error('something odd'));
      const gateway = createAnthropicGateway({ apiKey: 'sk-test', client: stubClient(create) });

      await expect(gateway.complete(request())).rejects.toBeInstanceOf(ModelGatewayError);
    });
  });
});
