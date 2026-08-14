import { describe, expect, it, vi } from 'vitest';

import { ModelGatewayError, type ModelGateway, type ModelRequest } from './model-gateway.js';
import { REPURPOSE_PROMPT_VERSION, repurposeSchema, repurposeSource } from './repurpose.js';

/**
 * The grounding gate is the point of this pipeline, so most of these tests are about what
 * happens when the model cites something that is not there. A model asked for citations
 * will produce plausible ones; the only question is whether anything checks.
 */

const ARTICLE = [
  'Acme raised 40 million dollars in a Series B round.',
  'The round was led by Northwind Capital.',
  'Chief executive Dana Reyes said "this lets us hire faster".',
].join(' ');

/** A gateway that returns exactly what the test says, and records what it was asked. */
function gatewayReturning(output: unknown): { gateway: ModelGateway; seen: ModelRequest[] } {
  const seen: ModelRequest[] = [];

  return {
    seen,
    gateway: {
      configured: true,
      complete: vi.fn(async (request: ModelRequest) => {
        seen.push(request);
        return {
          output,
          model: 'test-model',
          modelVersion: null,
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 5,
        };
      }),
    },
  };
}

const TARGETS = [{ key: 'a', provider: 'linkedin', maxCharacters: 3000 }];

describe('repurposeSource', () => {
  it('returns drafts whose claims cite real spans', async () => {
    const { gateway } = gatewayReturning({
      drafts: [
        {
          key: 'a',
          body: 'Acme just raised $40M.',
          claims: [
            { text: 'Acme raised 40 million dollars', kind: 'fact', source_span_ids: ['span_0'] },
          ],
        },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(false);
    expect(result.drafts[0]!.body).toBe('Acme just raised $40M.');
    expect(result.grounding[0]!.failures).toEqual([]);
  });

  /**
   * The failure this whole module exists for: a citation that looks right and points at
   * nothing. The set is still returned — recorded with the failure, not silently dropped —
   * so a human sees what the model claimed and why it was rejected.
   */
  it('flags a claim citing a span that does not exist', async () => {
    const { gateway } = gatewayReturning({
      drafts: [
        {
          key: 'a',
          body: 'Acme raised $90M.',
          claims: [{ text: 'Acme raised 90 million', kind: 'fact', source_span_ids: ['span_47'] }],
        },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(true);
    expect(result.grounding[0]!.failures[0]).toMatchObject({ reason: 'unknown_span' });
  });

  it('flags a claim that cites nothing at all', async () => {
    const { gateway } = gatewayReturning({
      drafts: [
        {
          key: 'a',
          body: 'Acme is the fastest growing company in the sector.',
          claims: [{ text: 'fastest growing in the sector', kind: 'fact', source_span_ids: [] }],
        },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(true);
    expect(result.grounding[0]!.failures[0]).toMatchObject({ reason: 'no_spans_cited' });
  });

  /**
   * A paraphrase presented as a quotation is the most damaging thing this pipeline could
   * publish — it puts words in a named person's mouth — so quotes are checked verbatim
   * even when the cited span is real.
   */
  it('rejects a quotation that is not verbatim in the span it cites', async () => {
    const { gateway } = gatewayReturning({
      drafts: [
        {
          key: 'a',
          body: 'Dana Reyes: "this lets us hire much faster than before".',
          claims: [
            {
              text: 'this lets us hire much faster than before',
              kind: 'quote',
              source_span_ids: ['span_2'],
            },
          ],
        },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(true);
    expect(result.grounding[0]!.failures[0]).toMatchObject({ reason: 'quote_not_present' });
  });

  it('accepts a verbatim quotation despite differing quote marks', async () => {
    const { gateway } = gatewayReturning({
      drafts: [
        {
          key: 'a',
          body: 'Dana Reyes said it lets them hire faster.',
          claims: [
            { text: 'this lets us hire faster', kind: 'quote', source_span_ids: ['span_2'] },
          ],
        },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(false);
  });

  /** Plenty of good social copy asserts nothing. Demanding citations universally would
   *  make the check meaningless by making it always fail. */
  it('treats a draft with no claims as grounded', async () => {
    const { gateway } = gatewayReturning({
      drafts: [{ key: 'a', body: 'Big news from the team today.', claims: [] }],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    expect(result.groundingFailed).toBe(false);
  });

  it('wraps the source and keeps it out of the instructions', async () => {
    const { gateway, seen } = gatewayReturning({
      drafts: [{ key: 'a', body: 'x', claims: [] }],
    });

    await repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS });

    const request = seen[0]!;
    expect(request.purpose).toBe('generation');
    expect(request.promptVersion).toBe(REPURPOSE_PROMPT_VERSION);
    // The article must never appear in the half of the prompt that carries our authority.
    expect(request.instructions).not.toContain('Northwind Capital');
    expect(request.untrustedContent).toContain('Northwind Capital');
    // Span ids have to be visible, or the model cannot cite anything real.
    expect(request.untrustedContent).toContain('[span_0]');
  });

  it('asks for exactly one draft per target', async () => {
    const targets = [
      { key: 'a', provider: 'linkedin' },
      { key: 'b', provider: 'x' },
    ];
    const { gateway, seen } = gatewayReturning({
      drafts: [
        { key: 'a', body: 'one', claims: [] },
        { key: 'b', body: 'two', claims: [] },
      ],
    });

    const result = await repurposeSource({ gateway, sourceText: ARTICLE, targets });

    expect(result.drafts.map((draft) => draft.key)).toEqual(['a', 'b']);
    const schema = seen[0]!.schema as { properties: { drafts: { minItems: number } } };
    expect(schema.properties.drafts.minItems).toBe(2);
  });

  it('fails loudly when the model skips a target', async () => {
    const { gateway } = gatewayReturning({
      drafts: [{ key: 'a', body: 'only one', claims: [] }],
    });

    await expect(
      repurposeSource({
        gateway,
        sourceText: ARTICLE,
        targets: [
          { key: 'a', provider: 'linkedin' },
          { key: 'b', provider: 'x' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
  });

  it('fails when the model returns no drafts array', async () => {
    const { gateway } = gatewayReturning({ something_else: true });

    await expect(
      repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS }),
    ).rejects.toBeInstanceOf(ModelGatewayError);
  });

  it('refuses a source with no readable text', async () => {
    const { gateway } = gatewayReturning({ drafts: [] });

    await expect(
      repurposeSource({ gateway, sourceText: '   ', targets: TARGETS }),
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION_FAILED' });
  });

  it('lets a gateway failure through unchanged so the caller can branch on it', async () => {
    const gateway: ModelGateway = {
      configured: true,
      complete: () => Promise.reject(new ModelGatewayError('RATE_LIMITED', 'slow down', true)),
    };

    await expect(
      repurposeSource({ gateway, sourceText: ARTICLE, targets: TARGETS }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });
});

describe('repurposeSchema', () => {
  /** Optional citations are the ones a model drops under length pressure, and a dropped
   *  citation is indistinguishable from a claim with no support. */
  it('requires a citation field on every claim', () => {
    const schema = repurposeSchema(['a']) as {
      properties: {
        drafts: { items: { properties: { claims: { items: { required: string[] } } } } };
      };
    };

    expect(schema.properties.drafts.items.properties.claims.items.required).toContain(
      'source_span_ids',
    );
  });

  it('constrains keys to the requested targets', () => {
    const schema = repurposeSchema(['a', 'b']) as {
      properties: { drafts: { items: { properties: { key: { enum: string[] } } } } };
    };

    expect(schema.properties.drafts.items.properties.key.enum).toEqual(['a', 'b']);
  });
});
