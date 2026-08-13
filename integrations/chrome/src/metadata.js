/**
 * Turning "the page I am looking at" into the article payload the API composes from.
 *
 * Split in two on purpose:
 *
 *   collectRawMeta   reads the DOM, and nothing else. It is handed to
 *                    `chrome.scripting.executeScript`, which serializes the function and
 *                    runs it in the page — so it must reference nothing outside its own
 *                    body. No imports, no helpers, no constants.
 *
 *   buildArticle     the precedence rules, with no DOM anywhere. This is where every
 *                    decision worth getting right lives, and keeping it pure is what makes
 *                    it testable without a browser.
 *
 * The extension contains no platform logic. It never counts a character or checks an
 * aspect ratio — `POST /v1/articles/compose` does that, identically for the WordPress
 * plugin and the agent tool. A rule compiled into an extension is wrong the week a network
 * changes it and stays wrong until every installed copy updates.
 */

/**
 * Read everything interesting off a page.
 *
 * Self-contained by requirement — see above. That is why it looks repetitive.
 *
 * `doc` defaults to the global `document` so this can be handed straight to
 * `chrome.scripting.executeScript`, which serializes the function and calls it with no
 * arguments in the page. The alternative — injecting a wrapper that evaluates the source
 * with `new Function` — is blocked outright by the content security policy of any site
 * strict enough to set one, which is exactly the kind of site worth sharing from.
 */
export function collectRawMeta(doc = document) {
  const meta = {};
  for (const tag of doc.querySelectorAll('meta')) {
    const key = tag.getAttribute('property') || tag.getAttribute('name');
    const value = tag.getAttribute('content');
    if (key && value && !meta[key]) meta[key] = value;
  }

  const jsonLd = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(script.textContent));
    } catch {
      // A malformed block on someone else's page is not our problem to report.
    }
  }

  const canonical = doc.querySelector('link[rel="canonical"]');

  // The first few paragraphs, as a last-resort summary source. Taken from the article
  // element when the page marks one up, because otherwise this collects the cookie banner.
  const scope =
    doc.querySelector('article') || doc.querySelector('main') || doc.body;
  const paragraphs = [];
  if (scope) {
    for (const p of scope.querySelectorAll('p')) {
      const text = (p.textContent || '').trim();
      if (text.length > 40) paragraphs.push(text);
      if (paragraphs.length >= 5) break;
    }
  }

  return {
    meta,
    jsonLd,
    title: doc.title || '',
    canonical: canonical ? canonical.getAttribute('href') : null,
    url: doc.location ? doc.location.href : '',
    paragraphs,
  };
}

/** The first non-empty, trimmed string from a list of candidates. */
function firstOf(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/** Flatten JSON-LD, which may be a graph, an array, or a single object. */
function jsonLdNodes(blocks) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    nodes.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  blocks.forEach(visit);
  return nodes;
}

/** The JSON-LD node describing the page itself, if there is one. */
function articleNode(blocks) {
  const isArticle = (type) =>
    typeof type === 'string' && /article|blogposting|newsarticle|webpage/i.test(type);

  for (const node of jsonLdNodes(blocks)) {
    const type = node['@type'];
    if (Array.isArray(type) ? type.some(isArticle) : isArticle(type)) return node;
  }
  return null;
}

/**
 * Build the article payload.
 *
 * The precedence throughout is: what the author explicitly published for sharing
 * (Open Graph), then structured data, then what the page happens to render. Open Graph
 * wins because it is the one thing on a page that was written *to be* shared — the
 * `<title>` is frequently "Post Title | Site Name | Category", which is not a headline
 * anybody would choose to post.
 */
export function buildArticle(raw) {
  const meta = raw.meta || {};
  const node = articleNode(raw.jsonLd || []) || {};

  const title = firstOf(
    meta['og:title'],
    meta['twitter:title'],
    typeof node.headline === 'string' ? node.headline : null,
    raw.title,
  );

  // Canonical before the address bar: the address bar carries whatever tracking parameters
  // the visitor arrived with, and sharing those attributes our own traffic to whoever last
  // linked the page.
  const url = firstOf(
    meta['og:url'],
    raw.canonical,
    typeof node.url === 'string' ? node.url : null,
    raw.url,
  );

  const excerpt = firstOf(
    meta['og:description'],
    meta['twitter:description'],
    meta.description,
    typeof node.description === 'string' ? node.description : null,
  );

  const image = firstOf(
    meta['og:image:secure_url'],
    meta['og:image'],
    meta['twitter:image'],
    typeof node.image === 'string' ? node.image : null,
    Array.isArray(node.image) ? node.image.find((i) => typeof i === 'string') : null,
    node.image && typeof node.image === 'object' ? node.image.url : null,
  );

  const publishedAt = firstOf(
    meta['article:published_time'],
    typeof node.datePublished === 'string' ? node.datePublished : null,
  );

  const tags = [];
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'article:tag' || key === 'keywords') {
      for (const part of String(value).split(',')) {
        const tag = part.trim();
        if (tag && !tags.includes(tag)) tags.push(tag);
      }
    }
  }

  const article = {
    title: title || '',
    url: url || '',
    // The body the API summarizes from when there is no description to prefer. Sent as
    // text rather than HTML because what was scraped off the page is already stripped of
    // its markup, and claiming otherwise would have the API parse tags that are not there.
    content: (raw.paragraphs || []).join('\n\n'),
    content_format: 'text',
    tags: tags.slice(0, 10),
  };

  if (excerpt) article.excerpt = excerpt;
  if (image) article.featured_image_url = image;
  if (meta['og:image:alt']) article.featured_image_alt = meta['og:image:alt'];
  if (publishedAt) article.published_at = publishedAt;

  return article;
}

/**
 * Whether a page has enough on it to be worth sharing.
 *
 * A URL alone is not enough: the composer needs something to write from, and an extension
 * that cheerfully shares an untitled blank page is one people uninstall.
 */
export function isShareable(article) {
  return Boolean(article.title && article.url && /^https?:\/\//i.test(article.url));
}
