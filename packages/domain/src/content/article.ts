import { htmlToText } from './untrusted-source.js';

/**
 * Turning an article into a social post, deterministically (plan §63C, §63M).
 *
 * This is the on-ramp for the largest group of people who need this product and are least
 * able to build against an API: somebody who publishes a blog and wants it to appear on
 * their networks. It is the engine behind the WordPress plugin, the site-builder
 * integrations, the browser extension and the agent tool — one derivation, so a post looks
 * the same however it was triggered.
 *
 * **Nothing here writes copy.** It selects, trims and assembles text the author already
 * wrote, and reports every choice it made. That restraint is the same one the composer
 * makes: rewriting is a model call somebody reviews (plan §63R), not something a share
 * button does quietly on your behalf. It also means this works with no model provider
 * configured, which is the difference between a feature that ships and one that waits.
 *
 * The order of preference for the body is deliberate, and each step is reported so a
 * plugin can say *why* it chose what it did:
 *
 *   1. an explicit excerpt          the author wrote it to be a summary
 *   2. the meta description         the author wrote it to be a summary, for search
 *   3. the opening sentences        the author's own words, in their own order
 *
 * Never a keyword-stuffed sentence assembled from the title, which is what most auto-share
 * plugins produce and what makes an auto-shared post recognisable as one.
 */

export interface ArticleInput {
  title: string;
  /** Canonical URL. Becomes the link, and the thing the post is actually for. */
  url?: string | null;
  /** Body, as HTML or plain text. */
  content?: string | null;
  contentFormat?: 'html' | 'text';
  /** The author's own summary, if they wrote one. Preferred over anything derived. */
  excerpt?: string | null;
  metaDescription?: string | null;
  tags?: readonly string[];
}

export interface ArticleDerivationOptions {
  /** Characters available for the body before the link and hashtags are appended. */
  maxBodyLength?: number;
  includeLink?: boolean;
  includeHashtags?: boolean;
  maxHashtags?: number;
}

export type DerivationSource = 'excerpt' | 'meta_description' | 'opening_sentences' | 'title_only';

export interface ArticleDerivation {
  /** The assembled post text, ready to hand to the composer. */
  text: string;
  /** Which part of the article the body came from. Surfaced, never guessed at silently. */
  source: DerivationSource;
  /** Hashtags derived from the article's tags, in the order the tags were given. */
  hashtags: readonly string[];
  linkUrl: string | null;
  /** Plain-language account of every choice, for a UI that has to explain itself. */
  notes: readonly string[];
}

const DEFAULT_MAX_BODY = 400;
const DEFAULT_MAX_HASHTAGS = 3;

/**
 * Sentence-ish split.
 *
 * Deliberately conservative about abbreviations — breaking "Inc." or "e.g." mid-sentence
 * produces a post that reads as broken, and a slightly long first sentence never does.
 */
const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Inc|Ltd|Co|vs|etc|e\.g|i\.e|approx|No)\.$/i;

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';

  for (const part of text.split(/(?<=[.!?])\s+/)) {
    current = current ? `${current} ${part}` : part;
    if (ABBREVIATIONS.test(current.trim())) continue;
    sentences.push(current.trim());
    current = '';
  }

  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean);
}

/**
 * As many whole sentences as fit.
 *
 * Whole sentences, never a truncation with an ellipsis. A post that stops mid-clause reads
 * as a machine's output, and the reader has to click to find out whether they cared —
 * which is a worse invitation than a complete shorter thought.
 */
function openingSentences(text: string, limit: number): string {
  const sentences = splitSentences(text);
  let out = '';

  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > limit) break;
    out = candidate;
  }

  // Nothing fit: one sentence longer than the whole budget. Take it and let the composer's
  // per-network truncation deal with it — it knows each platform's real limit, this
  // function does not.
  return out || (sentences[0] ?? '');
}

/**
 * `social media` → `#SocialMedia`.
 *
 * Camel-cased rather than lowercased because `#socialmediamarketing` is unreadable and,
 * more practically, screen readers pronounce the camel-cased form as words.
 */
export function toHashtag(tag: string): string | null {
  const cleaned = tag
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim();

  if (!cleaned) return null;

  const words = cleaned.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return null;

  // A tag that is already one word keeps the author's own capitalization — `#WordPress`
  // is theirs to spell, and title-casing it would produce `#Wordpress`.
  if (words.length === 1) return `#${words[0]}`;

  return `#${words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Derive a social post from an article.
 *
 * Pure: no network, no model, no database. That is what lets the same derivation run in the
 * API, in a test, and — if it ever needs to — inside a plugin, and produce identical text.
 */
export function deriveArticlePost(
  article: ArticleInput,
  options: ArticleDerivationOptions = {},
): ArticleDerivation {
  const maxBody = options.maxBodyLength ?? DEFAULT_MAX_BODY;
  const includeLink = options.includeLink ?? true;
  const includeHashtags = options.includeHashtags ?? true;
  const maxHashtags = options.maxHashtags ?? DEFAULT_MAX_HASHTAGS;

  const notes: string[] = [];
  const title = normalizeWhitespace(article.title);

  const excerpt = article.excerpt ? normalizeWhitespace(htmlToText(article.excerpt)) : '';
  const metaDescription = article.metaDescription
    ? normalizeWhitespace(article.metaDescription)
    : '';

  const body =
    article.content && article.contentFormat !== 'text'
      ? normalizeWhitespace(htmlToText(article.content))
      : normalizeWhitespace(article.content ?? '');

  let source: DerivationSource;
  let summary: string;

  if (excerpt) {
    source = 'excerpt';
    summary = excerpt.length > maxBody ? openingSentences(excerpt, maxBody) : excerpt;
    notes.push('Used the excerpt you wrote, rather than deriving one.');
  } else if (metaDescription) {
    source = 'meta_description';
    summary = metaDescription;
    notes.push('Used the meta description, since there is no excerpt.');
  } else if (body) {
    source = 'opening_sentences';
    summary = openingSentences(body, maxBody);
    notes.push('Used the opening sentences of the article, unchanged.');
  } else {
    source = 'title_only';
    summary = '';
    notes.push('The article has no excerpt or body, so the post is the headline and the link.');
  }

  /**
   * The title leads unless the summary already opens with it.
   *
   * A post that reads "How to bake bread — How to bake bread is a guide to…" is the
   * signature of an auto-share plugin, and it is what a naive title-plus-excerpt
   * concatenation always produces when the author wrote a self-referential excerpt.
   */
  const summaryOpensWithTitle =
    summary.length > 0 && summary.slice(0, title.length).toLowerCase() === title.toLowerCase();

  if (summaryOpensWithTitle) {
    notes.push('Left the headline out, because the summary already opens with it.');
  }

  const lead = summaryOpensWithTitle ? summary : [title, summary].filter(Boolean).join('\n\n');

  const hashtags = includeHashtags
    ? (article.tags ?? [])
        .map(toHashtag)
        .filter((tag): tag is string => tag !== null)
        .filter((tag, index, all) => all.indexOf(tag) === index)
        .slice(0, maxHashtags)
    : [];

  if (includeHashtags && (article.tags?.length ?? 0) > hashtags.length) {
    notes.push(
      `Kept ${hashtags.length} of ${article.tags?.length ?? 0} tags as hashtags — past about ` +
        'three they stop helping reach and start looking like spam.',
    );
  }

  const linkUrl = includeLink ? (article.url ?? null) : null;
  if (!includeLink && article.url) {
    notes.push('Left the link out, as asked.');
  }

  /**
   * The link goes in the text, not only in `link_url`.
   *
   * Networks differ on whether a link field exists at all, and the composer strips the
   * inline URL for the ones that carry it separately. Including it here means the platforms
   * without a link field — most of them — still send readers to the article, which is the
   * entire point of sharing it.
   */
  const text = [lead, hashtags.join(' '), linkUrl].filter(Boolean).join('\n\n');

  return { text, source, hashtags, linkUrl, notes };
}
