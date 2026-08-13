import { z } from 'zod';

import { ComposeModeSchema, ComposeResponseSchema } from './compose.js';

/**
 * Article sharing (plan §63O "publisher / media-site automation").
 *
 * One call takes a published article and returns, per network, exactly what would be
 * posted. It exists because the largest group of people who need this product — somebody
 * who runs a site and wants their posts to appear on their networks — are the least able
 * to build the five-call sequence that produced the same result: register the featured
 * image, derive a summary, assemble text, compose, publish.
 *
 * Every integration is a client of this: the WordPress plugin, the site-builder apps, the
 * browser extension and the agent tool all send the same body. One derivation means a post
 * looks the same however it was triggered, and a bug fixed here is fixed in all of them
 * without anybody updating a plugin.
 *
 * It does not publish, for the same reason `POST /v1/compose` does not: `POST /v1/posts`
 * stays the only thing that publishes, so there is one idempotency story and one state
 * machine rather than two.
 */

export const ArticleSchema = z
  .object({
    title: z.string().min(1).max(500),
    /** Canonical URL. Becomes the link, and the thing the post is actually for. */
    url: z.url().nullish(),
    /** The body, as HTML straight from the CMS or as plain text. Markup is stripped. */
    content: z.string().max(400_000).nullish(),
    content_format: z.enum(['html', 'text']).default('html'),
    /**
     * The author's own summary. Preferred over anything derived from the body, because
     * they wrote it to be a summary and we would only be guessing at one.
     */
    excerpt: z.string().max(5000).nullish(),
    meta_description: z.string().max(1000).nullish(),
    /**
     * Registered as media automatically. A featured image is the difference between a
     * link that shows up as a grey box and one that stops a thumb, and asking a plugin
     * author to make a separate upload call to get it is how it ends up omitted.
     */
    featured_image_url: z.url().nullish(),
    featured_image_alt: z.string().max(2000).nullish(),
    tags: z.array(z.string().max(100)).max(50).default([]),
    published_at: z.iso.datetime().nullish(),
  })
  .strict();

export const ComposeArticleRequestSchema = z
  .object({
    profile_id: z.string(),
    article: ArticleSchema,
    targets: z
      .array(z.object({ destination_id: z.string() }).strict())
      .min(1)
      .max(50),
    mode: ComposeModeSchema.default('optimize'),
    /** The link is included in the text as well as the link field — most networks have no
     *  link field, and leaving it out means the share sends nobody to the article. */
    include_link: z.boolean().default(true),
    include_hashtags: z.boolean().default(true),
    /** Past about three, hashtags stop helping reach and start looking like spam. */
    max_hashtags: z.number().int().min(0).max(10).default(3),
  })
  .strict();

export const ArticleDerivationSchema = z
  .object({
    /** Which part of the article the body came from — surfaced, never chosen silently. */
    source: z.enum(['excerpt', 'meta_description', 'opening_sentences', 'title_only']),
    text: z.string(),
    hashtags: z.array(z.string()),
    link_url: z.string().nullable(),
    /** The media id the featured image was registered as, if there was one. */
    media_id: z.string().nullable(),
    /**
     * Plain-language account of every choice made.
     *
     * A share button that silently rewrites your words is the thing people distrust about
     * this whole category, so every decision is stated: which summary was used, why the
     * headline was left out, how many tags survived.
     */
    notes: z.array(z.string()),
  })
  .strict();

export const ComposeArticleResponseSchema = z
  .object({
    object: z.literal('article_composition'),
    /** What was derived from the article, before any per-network adaptation. */
    derived: ArticleDerivationSchema,
    /**
     * The per-network result, identical in shape to `POST /v1/compose` — including
     * `publish_override`, so publishing is one more call with no reconstruction.
     */
    composition: ComposeResponseSchema,
  })
  .strict();

export type ComposeArticleRequest = z.infer<typeof ComposeArticleRequestSchema>;
export type ComposeArticleResponse = z.infer<typeof ComposeArticleResponseSchema>;
