import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import app from '../index.js';
import {
  createHarness,
  databaseUrl,
  executionContext,
  type RouteHarness,
} from '../test-support/harness.js';

/**
 * Article sharing route tests, including the tenant-ownership tests Rule 5 requires.
 *
 * The behaviour worth pinning down is what the derivation refuses to do, and that the
 * route composes the existing endpoints rather than acquiring its own rules — the whole
 * value of `/v1/articles/compose` is that a WordPress plugin, a browser extension and an
 * agent all get identical output.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('article sharing', () => {
  let h: RouteHarness;
  let noMediaScopeKey: string;

  beforeAll(async () => {
    h = await createHarness(['posts:read', 'posts:write', 'media:write', 'media:read']);
    noMediaScopeKey = await h.issueKey(h.tenantA, ['posts:read']);
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const post = async (path: string, body: unknown, key?: string): Promise<Response> =>
    await app.request(
      path,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key ?? h.tenantA.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      h.env,
      executionContext,
    );

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const code = async (response: Response): Promise<string> =>
    (await json<{ error: { code: string } }>(response)).error.code;

  /**
   * A valid request, with `overrides` merged in.
   *
   * `...overrides` has to come *before* `article`, not after. Spread last, it put the
   * caller's raw `{ article: { excerpt } }` back over the merged object and threw away the
   * title and URL — so six of these tests were quietly sending a titleless article and
   * asserting against the 400 that came back rather than against the behaviour they name.
   * Every one of them passed the day it was written and has been red ever since.
   */
  const article = (overrides: Record<string, unknown> = {}) => ({
    profile_id: h.tenantA.publicProfileId,
    targets: [{ destination_id: h.tenantA.publicDestinationId }],
    ...overrides,
    article: {
      title: 'How we cut publishing latency in half',
      url: 'https://blog.example.com/latency',
      content: '<p>We shipped a change. It halved our latency. Here is how it went.</p>',
      tags: ['engineering', 'social media'],
      ...((overrides.article as Record<string, unknown>) ?? {}),
    },
  });

  interface Composition {
    object: string;
    derived: {
      source: string;
      text: string;
      hashtags: string[];
      link_url: string | null;
      media_id: string | null;
      notes: string[];
    };
    composition: {
      ready: boolean;
      targets: { destination_id: string; publish_override: Record<string, unknown> }[];
    };
  }

  describe('composition', () => {
    it('derives a post from the article and previews it per network', async () => {
      const response = await post('/v1/articles/compose', article());
      expect(response.status).toBe(200);

      const body = await json<Composition>(response);
      expect(body.object).toBe('article_composition');
      expect(body.derived.source).toBe('opening_sentences');
      expect(body.derived.text).toContain('How we cut publishing latency in half');
      expect(body.derived.text).toContain('We shipped a change.');
      expect(body.composition.targets).toHaveLength(1);
    });

    it('returns a publish_override, so publishing needs no reconstruction', async () => {
      const body = await json<Composition>(await post('/v1/articles/compose', article()));

      // Without this a caller re-derives the adaptation themselves, and any drift means
      // publishing something other than the preview the author approved.
      const [target] = body.composition.targets;
      expect(target?.publish_override).toBeDefined();
      expect(target?.destination_id).toBe(h.tenantA.publicDestinationId);
    });

    it('prefers the author’s excerpt and says so', async () => {
      const body = await json<Composition>(
        await post(
          '/v1/articles/compose',
          article({ article: { excerpt: 'A summary the author wrote.' } }),
        ),
      );

      expect(body.derived.source).toBe('excerpt');
      expect(body.derived.text).toContain('A summary the author wrote.');
      expect(body.derived.notes.some((note) => note.includes('excerpt you wrote'))).toBe(true);
    });

    it('strips markup rather than publishing it', async () => {
      const body = await json<Composition>(
        await post(
          '/v1/articles/compose',
          article({ article: { content: '<p>Real text.</p><script>alert(1)</script>' } }),
        ),
      );

      expect(body.derived.text).not.toContain('<p>');
      expect(body.derived.text).not.toContain('alert');
    });

    it('caps hashtags and keeps the link in the body', async () => {
      const body = await json<Composition>(
        await post(
          '/v1/articles/compose',
          article({ article: { tags: ['a', 'b', 'c', 'd', 'e'] }, max_hashtags: 2 }),
        ),
      );

      expect(body.derived.hashtags).toHaveLength(2);
      // Most networks have no link field; omitting it from the text would mean the share
      // sends nobody to the article.
      expect(body.derived.text).toContain('https://blog.example.com/latency');
    });

    it('omits the link when asked', async () => {
      const body = await json<Composition>(
        await post('/v1/articles/compose', article({ include_link: false })),
      );

      expect(body.derived.link_url).toBeNull();
      expect(body.derived.text).not.toContain('blog.example.com');
    });

    it('accepts an article with only a headline and a link', async () => {
      const response = await post(
        '/v1/articles/compose',
        article({ article: { content: null, tags: [] } }),
      );

      expect(response.status).toBe(200);
      const body = await json<Composition>(response);
      expect(body.derived.source).toBe('title_only');
    });

    it('composing never publishes', async () => {
      await post('/v1/articles/compose', article());

      const listed = await app.request(
        '/v1/posts',
        { headers: { authorization: `Bearer ${h.tenantA.apiKey}` } },
        h.env,
        executionContext,
      );

      const body = await json<{ data: unknown[] }>(listed);
      expect(body.data).toEqual([]);
    });
  });

  describe('featured images', () => {
    /**
     * Plan §68. A caller-supplied URL that resolves to a private address is the classic
     * SSRF, and the article route must not become a way around the media route's guard.
     */
    it('refuses a featured image on a private address', async () => {
      const response = await post(
        '/v1/articles/compose',
        article({ article: { featured_image_url: 'https://127.0.0.1/logo.png' } }),
      );

      expect(response.status).toBe(422);
      expect(await code(response)).toBe('MEDIA_URL_NOT_ALLOWED');
    });

    it('names the image in the error rather than blaming the composition', async () => {
      const response = await post(
        '/v1/articles/compose',
        article({ article: { featured_image_url: 'https://169.254.169.254/meta.png' } }),
      );

      const body = await json<{ error: { message: string; param?: string } }>(response);
      expect(body.error.message).toContain('featured image');
      expect(body.error.param).toBe('article.featured_image_url');
    });
  });

  describe('authorization', () => {
    it('requires media:write even when no image is sent', async () => {
      // Conditional scope requirements mean a key's permissions depend on the body, which
      // nobody can reason about when a call starts failing.
      const response = await post('/v1/articles/compose', article(), noMediaScopeKey);

      expect(response.status).toBe(403);
      expect(await code(response)).toBe('INSUFFICIENT_SCOPE');
    });

    it('cannot compose for another tenant’s profile', async () => {
      const response = await post('/v1/articles/compose', article(), h.tenantB.apiKey);
      expect(response.status).toBe(404);
    });

    it('cannot compose to another tenant’s destination', async () => {
      const response = await post(
        '/v1/articles/compose',
        {
          profile_id: h.tenantB.publicProfileId,
          article: { title: 'Theirs', url: 'https://example.com/x' },
          targets: [{ destination_id: h.tenantA.publicDestinationId }],
        },
        h.tenantB.apiKey,
      );

      // 403, the same as `POST /v1/posts` and `/v1/posts/preflight` — this route resolves
      // targets through the identical helper, and asserting a different code here would be
      // asserting that composing an article is a different security decision from
      // publishing one. It is not.
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('TENANT_FORBIDDEN');
    });

    it('rejects an article with no title', async () => {
      const response = await post(
        '/v1/articles/compose',
        article({ article: { title: '' } }),
      );

      expect(response.status).toBe(400);
      expect(await code(response)).toBe('INVALID_REQUEST');
    });
  });
});
