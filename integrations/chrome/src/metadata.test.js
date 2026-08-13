import { describe, expect, it } from 'vitest';

import { buildArticle, isShareable } from './metadata.js';

/**
 * Extraction precedence.
 *
 * Every case here is a real page shape. The failure mode being guarded against is quiet:
 * a wrong pick still produces a shareable post, so nothing errors — it just publishes the
 * site name as the headline, or shares a URL carrying somebody else's tracking parameters.
 *
 * `buildArticle` is pure, so none of this needs a DOM.
 */

const raw = (over = {}) => ({
  meta: {},
  jsonLd: [],
  title: '',
  canonical: null,
  url: 'https://example.com/page',
  paragraphs: [],
  ...over,
});

describe('title', () => {
  it('prefers Open Graph over the document title', () => {
    // The document title is routinely "Headline | Section | Site Name". Open Graph is the
    // one field on the page written specifically to be shared.
    const article = buildArticle(
      raw({
        meta: { 'og:title': 'How we cut latency in half' },
        title: 'How we cut latency in half | Engineering | Example Inc',
      }),
    );

    expect(article.title).toBe('How we cut latency in half');
  });

  it('falls back through twitter, then JSON-LD, then the document title', () => {
    expect(buildArticle(raw({ meta: { 'twitter:title': 'From Twitter' }, title: 'Doc' })).title).toBe(
      'From Twitter',
    );

    expect(
      buildArticle(
        raw({ jsonLd: [{ '@type': 'BlogPosting', headline: 'From JSON-LD' }], title: 'Doc' }),
      ).title,
    ).toBe('From JSON-LD');

    expect(buildArticle(raw({ title: 'Doc' })).title).toBe('Doc');
  });

  it('ignores a whitespace-only value rather than treating it as present', () => {
    expect(buildArticle(raw({ meta: { 'og:title': '   ' }, title: 'Doc' })).title).toBe('Doc');
  });
});

describe('url', () => {
  it('prefers the canonical URL over the address bar', () => {
    // The address bar carries whatever campaign parameters the visitor arrived with.
    // Sharing those credits our traffic to whoever last linked the page.
    const article = buildArticle(
      raw({
        canonical: 'https://example.com/article',
        url: 'https://example.com/article?utm_source=newsletter&fbclid=abc123',
      }),
    );

    expect(article.url).toBe('https://example.com/article');
  });

  it('prefers og:url over canonical', () => {
    const article = buildArticle(
      raw({ meta: { 'og:url': 'https://example.com/og' }, canonical: 'https://example.com/canon' }),
    );

    expect(article.url).toBe('https://example.com/og');
  });
});

describe('images', () => {
  it('takes the secure variant first', () => {
    const article = buildArticle(
      raw({
        meta: {
          'og:image': 'http://example.com/insecure.jpg',
          'og:image:secure_url': 'https://example.com/secure.jpg',
        },
      }),
    );

    expect(article.featured_image_url).toBe('https://example.com/secure.jpg');
  });

  it('reads JSON-LD images given as an array or an object', () => {
    expect(
      buildArticle(raw({ jsonLd: [{ '@type': 'Article', image: ['https://example.com/a.jpg'] }] }))
        .featured_image_url,
    ).toBe('https://example.com/a.jpg');

    expect(
      buildArticle(
        raw({ jsonLd: [{ '@type': 'Article', image: { url: 'https://example.com/b.jpg' } }] }),
      ).featured_image_url,
    ).toBe('https://example.com/b.jpg');
  });

  it('omits the field entirely when there is no image', () => {
    // Absent rather than empty: the API treats a present-but-empty URL as something to
    // fetch, and fails the compose on it.
    expect(buildArticle(raw())).not.toHaveProperty('featured_image_url');
  });
});

describe('JSON-LD shapes', () => {
  it('finds the article inside an @graph', () => {
    const article = buildArticle(
      raw({
        jsonLd: [
          {
            '@context': 'https://schema.org',
            '@graph': [
              { '@type': 'Organization', name: 'Example Inc' },
              { '@type': 'NewsArticle', headline: 'Buried in a graph' },
            ],
          },
        ],
      }),
    );

    expect(article.title).toBe('Buried in a graph');
  });

  it('handles @type given as an array', () => {
    const article = buildArticle(
      raw({ jsonLd: [{ '@type': ['WebPage', 'Article'], headline: 'Multi-typed' }] }),
    );

    expect(article.title).toBe('Multi-typed');
  });

  it('ignores nodes that are not articles', () => {
    const article = buildArticle(
      raw({ jsonLd: [{ '@type': 'Organization', name: 'Example Inc' }], title: 'Doc' }),
    );

    expect(article.title).toBe('Doc');
  });
});

describe('tags', () => {
  it('splits keywords and drops duplicates', () => {
    const article = buildArticle(raw({ meta: { keywords: 'react, react, performance ,  ' } }));

    expect(article.tags).toEqual(['react', 'performance']);
  });

  it('caps the list, because the API only uses a handful', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`).join(',');
    expect(buildArticle(raw({ meta: { keywords: many } })).tags).toHaveLength(10);
  });
});

describe('body', () => {
  it('joins the collected paragraphs for the composer to summarize from', () => {
    const article = buildArticle(raw({ paragraphs: ['First para.', 'Second para.'] }));

    expect(article.content).toBe('First para.\n\nSecond para.');
    // Declared as text, not HTML: what was scraped is already stripped of its markup, and
    // saying otherwise makes the API parse tags that are not there.
    expect(article.content_format).toBe('text');
  });
});

describe('isShareable', () => {
  it('accepts a page with a title and an http URL', () => {
    expect(isShareable({ title: 'A post', url: 'https://example.com/x' })).toBe(true);
  });

  it('rejects a page with no title', () => {
    expect(isShareable({ title: '', url: 'https://example.com/x' })).toBe(false);
  });

  it('rejects browser-internal pages, which cannot be shared or fetched', () => {
    expect(isShareable({ title: 'New Tab', url: 'chrome://newtab' })).toBe(false);
    expect(isShareable({ title: 'A file', url: 'file:///C:/notes.html' })).toBe(false);
  });
});
