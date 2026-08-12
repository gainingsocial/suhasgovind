import { createHarness, databaseUrl, executionContext, type RouteHarness } from '../test-support/harness.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';

/**
 * The Smart Universal Composer (plan §63B, §63C).
 *
 * > Upload once. Write once. Select networks. We prepare everything else.
 *
 * What these assert is the promise, not the plumbing: an author who writes one thing gets
 * back exactly what each network will publish, nothing is changed without being reported,
 * and the override handed back reproduces the preview rather than approximating it.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('POST /v1/compose', () => {
  let h: RouteHarness;

  beforeAll(async () => {
    h = await createHarness(['posts:read', 'posts:write']);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  interface ComposeBody {
    object: string;
    mode: string;
    ready: boolean;
    summary: string;
    targets: {
      destination_id: string;
      provider: string;
      status: string;
      summary: string;
      preview: { text: string; first_comment_hashtags: string[] };
      text_adaptations: { kind: string; decision: string; reason: string }[];
      media_fit: unknown;
      errors: { code: string }[];
      publish_override: Record<string, unknown>;
    }[];
  }

  async function compose(
    body: Record<string, unknown>,
    apiKey = h.tenantA.apiKey,
  ): Promise<Response> {
    return app.request(
      '/v1/compose',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      h.env,
      executionContext,
    );
  }

  const baseRequest = (text: string, mode: 'exact' | 'optimize' = 'optimize') => ({
    profile_id: h.tenantA.publicProfileId,
    content: { text, media_ids: [] },
    targets: [{ destination_id: h.tenantA.publicDestinationId }],
    mode,
  });

  it('reports every network ready when the post already fits', async () => {
    const response = await compose(baseRequest('A short post that fits anywhere.'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as ComposeBody;

    expect(body.object).toBe('composition');
    expect(body.ready).toBe(true);
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]?.status).toBe('ready');
    // Plain language first (plan §63C) — a person should not have to read a code.
    expect(body.summary).toContain('ready to publish');
  });

  it('previews exactly what would be published', async () => {
    const text = 'The exact words that go out.';
    const body = (await (await compose(baseRequest(text))).json()) as ComposeBody;

    expect(body.targets[0]?.preview.text).toBe(text);
  });

  it('hands back an override with no text when nothing was adapted', async () => {
    // An override restating unchanged canonical text would make later edits to the post
    // silently fail to reach this target.
    const body = (await (await compose(baseRequest('Unchanged.'))).json()) as ComposeBody;

    expect(body.targets[0]?.publish_override).toEqual({
      destination_id: h.tenantA.publicDestinationId,
    });
  });

  it('never publishes anything', async () => {
    // Composing is a preview. `POST /v1/posts` remains the only thing that publishes, which
    // keeps one idempotency story and one state machine rather than two.
    await compose(baseRequest('Just looking.'));

    const posts = await app.request(
      '/v1/posts',
      { headers: { authorization: `Bearer ${h.tenantA.apiKey}` } },
      h.env,
      executionContext,
    );

    expect(((await posts.json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it('refuses a destination belonging to another tenant (P5)', async () => {
    // Composing before checking ownership would leak the character limits and account
    // capabilities of somebody else's connected network.
    const response = await compose({
      profile_id: h.tenantA.publicProfileId,
      content: { text: 'hello', media_ids: [] },
      targets: [{ destination_id: h.tenantB.publicDestinationId }],
      mode: 'optimize',
    });

    expect(response.status).toBe(403);
  });

  it('rejects a malformed destination id', async () => {
    const response = await compose({
      profile_id: h.tenantA.publicProfileId,
      content: { text: 'hello', media_ids: [] },
      targets: [{ destination_id: 'not-an-id' }],
      mode: 'optimize',
    });

    expect(response.status).toBe(400);
  });

  it('requires a profile that exists', async () => {
    const response = await compose({
      profile_id: h.tenantB.publicProfileId,
      content: { text: 'hello', media_ids: [] },
      targets: [{ destination_id: h.tenantA.publicDestinationId }],
      mode: 'optimize',
    });

    // Cross-tenant profile and cross-tenant destination are refused identically, so
    // probing cannot distinguish "exists elsewhere" from "does not exist".
    expect([403, 404]).toContain(response.status);
  });

  it('defaults to optimize mode when none is given', async () => {
    const response = await compose({
      profile_id: h.tenantA.publicProfileId,
      content: { text: 'no mode supplied', media_ids: [] },
      targets: [{ destination_id: h.tenantA.publicDestinationId }],
    });

    expect(((await response.json()) as ComposeBody).mode).toBe('optimize');
  });

  it('reports adaptations rather than applying them silently', async () => {
    // Whatever the mock's limits are, anything the composer changed must appear in
    // `text_adaptations` — nothing done to an author's writing is a surprise (plan §18).
    const body = (await (await compose(baseRequest('x'.repeat(5000)))).json()) as ComposeBody;
    const target = body.targets[0]!;

    if (target.preview.text !== 'x'.repeat(5000)) {
      expect(target.text_adaptations.length).toBeGreaterThan(0);
      expect(target.text_adaptations[0]?.reason).toBeTruthy();
      // And the override carries the adapted text, so publishing reproduces the preview.
      expect((target.publish_override.overrides as { text: string }).text).toBe(
        target.preview.text,
      );
    }
  });

  it('changes nothing in exact mode', async () => {
    const text = 'x'.repeat(5000);
    const body = (await (await compose(baseRequest(text, 'exact'))).json()) as ComposeBody;

    expect(body.targets[0]?.preview.text).toBe(text);
    expect(body.targets[0]?.publish_override).toEqual({
      destination_id: h.tenantA.publicDestinationId,
    });
  });
});
