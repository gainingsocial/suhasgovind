import {
  ComposeArticleRequestSchema,
  ComposeArticleResponseSchema,
  type ComposeResponse,
} from '@gs/contracts/http';
import { deriveArticlePost } from '@gs/domain';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Share an article (plan §63O).
 *
 * The on-ramp for site owners, and the shared engine behind every integration: the
 * WordPress plugin, the site-builder apps, the browser extension and the agent tool all
 * post this same body. One derivation means a post looks the same however it was
 * triggered, and a fix here reaches every integration without anybody shipping a plugin
 * update.
 *
 * Composed of two existing endpoints rather than a third implementation. The featured
 * image goes through `POST /v1/media/external`, which already carries the SSRF rules
 * (plan §68) that make fetching a caller-supplied URL safe; the result goes through
 * `POST /v1/compose`, which already knows every network's limits. Re-entering the API
 * through its own front door — the pattern the MCP layer and draft sets both use — means
 * this route cannot drift from what those endpoints do, and cannot quietly acquire a
 * second set of platform rules.
 */

export type InternalDispatch = (
  request: Request,
  env: AppEnv['Bindings'],
  ctx: unknown,
) => Promise<Response> | Response;

type Ctx = Context<AppEnv>;

/**
 * Issue a request against our own routes, carrying the caller's authorization verbatim.
 *
 * Verbatim matters: sharing an article must not become a way to reach media or publishing
 * with scopes the key does not hold.
 */
async function dispatchJson(
  c: Ctx,
  dispatch: InternalDispatch,
  path: string,
  body: unknown,
): Promise<{ response: Response; payload: unknown }> {
  const trace = c.get('trace');
  const origin = c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': trace.requestId,
    'x-trace-id': trace.traceId,
  };

  const authorization = c.req.header('authorization');
  if (authorization) headers.authorization = authorization;

  const response = await dispatch(
    new Request(new URL(path, origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    c.env,
    c.executionCtx,
  );

  const text = await response.text();
  return { response, payload: text.length > 0 ? JSON.parse(text) : {} };
}

export function createArticleRoutes(dispatch: InternalDispatch): Hono<AppEnv> {
  const articles = new Hono<AppEnv>();

  articles.post(
    '/compose',
    withDatabase(),
    // `media:write` is required even when no image is sent. Requiring it conditionally
    // would mean a key's permissions depended on the body, which is the kind of rule
    // nobody can reason about when a call starts failing.
    authenticate(['posts:read', 'media:write']),
    async (c) => {
      const body = await parseBody(c, ComposeArticleRequestSchema);
      const { article } = body;

      /**
       * The featured image first, because it is the part that can fail for reasons
       * outside our control — an unreachable URL, a private address, a format nothing
       * accepts. Discovering that before composing means the error names the image
       * rather than surfacing as a puzzling composition result.
       */
      let mediaId: string | null = null;
      if (article.featured_image_url) {
        const { response, payload } = await dispatchJson(c, dispatch, '/v1/media/external', {
          profile_id: body.profile_id,
          url: article.featured_image_url,
          alt_text: article.featured_image_alt ?? article.title,
        });

        if (!response.ok) {
          const envelope = payload as { error?: { code?: string; message?: string } };
          throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
            message:
              `The featured image could not be used: ${envelope.error?.message ?? 'unknown reason'} ` +
              'Compose without it, or host the image somewhere publicly reachable over HTTPS.',
            param: 'article.featured_image_url',
          });
        }

        mediaId = (payload as { id: string }).id;
      }

      const derived = deriveArticlePost(
        {
          title: article.title,
          url: article.url ?? null,
          content: article.content ?? null,
          contentFormat: article.content_format,
          excerpt: article.excerpt ?? null,
          metaDescription: article.meta_description ?? null,
          tags: article.tags,
        },
        {
          includeLink: body.include_link,
          includeHashtags: body.include_hashtags,
          maxHashtags: body.max_hashtags,
        },
      );

      const { response, payload } = await dispatchJson(c, dispatch, '/v1/compose', {
        profile_id: body.profile_id,
        content: {
          text: derived.text,
          media_ids: mediaId ? [mediaId] : [],
          link_url: derived.linkUrl,
        },
        targets: body.targets,
        mode: body.mode,
      });

      // Compose's failures are already agent-native envelopes naming the destination and
      // the field at fault. Passing one through unchanged beats wrapping it in a vaguer
      // one that says an article could not be composed.
      if (!response.ok) {
        return c.json(payload as Record<string, unknown>, response.status as 400);
      }

      const notes = [...derived.notes];
      if (mediaId) {
        notes.push('Registered your featured image, and attached it wherever it is supported.');
      }

      return c.json(
        ComposeArticleResponseSchema.parse({
          object: 'article_composition',
          derived: {
            source: derived.source,
            text: derived.text,
            hashtags: derived.hashtags,
            link_url: derived.linkUrl,
            media_id: mediaId,
            notes,
          },
          composition: payload as ComposeResponse,
        }),
        200,
      );
    },
  );

  return articles;
}
