import { describe, expect, it } from 'vitest';

import { deriveArticlePost, toHashtag } from './article.js';

/**
 * The tests worth having are about what this refuses to do: invent copy, repeat the
 * headline, cut mid-sentence, or turn every tag into a hashtag.
 */

describe('deriveArticlePost', () => {
  const base = {
    title: 'How we cut publishing latency in half',
    url: 'https://blog.example.com/latency',
    tags: ['engineering', 'social media'],
  };

  it('prefers the author’s own excerpt over anything derived', () => {
    const result = deriveArticlePost({
      ...base,
      excerpt: 'A short summary the author wrote themselves.',
      content: '<p>A much longer body that should not be used.</p>',
    });

    expect(result.source).toBe('excerpt');
    expect(result.text).toContain('A short summary the author wrote themselves.');
    expect(result.text).not.toContain('much longer body');
  });

  it('falls back to the meta description before touching the body', () => {
    const result = deriveArticlePost({
      ...base,
      metaDescription: 'What search engines were told this page is about.',
      content: '<p>The body.</p>',
    });

    expect(result.source).toBe('meta_description');
  });

  it('uses the opening sentences unchanged when there is no summary', () => {
    const result = deriveArticlePost({
      ...base,
      content: '<p>We shipped a change. It halved our latency. Here is how.</p>',
    });

    expect(result.source).toBe('opening_sentences');
    expect(result.text).toContain('We shipped a change.');
  });

  /**
   * "How to bake bread — How to bake bread is a guide to…" is the signature of an
   * auto-share plugin, and it is what naive title-plus-excerpt concatenation always
   * produces when the author wrote a self-referential excerpt.
   */
  it('does not repeat the headline when the summary already opens with it', () => {
    const result = deriveArticlePost({
      ...base,
      excerpt: 'How we cut publishing latency in half, and what we learned.',
    });

    const occurrences = result.text.split('How we cut publishing latency in half').length - 1;
    expect(occurrences).toBe(1);
    expect(result.notes.some((note) => note.includes('already opens with it'))).toBe(true);
  });

  it('leads with the headline when the summary does not', () => {
    const result = deriveArticlePost({ ...base, excerpt: 'It took three weeks and one rewrite.' });
    expect(result.text.startsWith('How we cut publishing latency in half')).toBe(true);
  });

  it('cuts on a sentence boundary rather than mid-clause', () => {
    const result = deriveArticlePost(
      {
        ...base,
        content: 'First sentence here. Second sentence here. Third sentence here.',
        contentFormat: 'text',
      },
      { maxBodyLength: 40 },
    );

    expect(result.text).not.toContain('…');
    expect(result.text).toContain('First sentence here.');
    expect(result.text).not.toContain('Third sentence');
  });

  it('does not break on an abbreviation', () => {
    const result = deriveArticlePost(
      {
        ...base,
        content: 'We spoke to Acme Inc. about the change. Then we shipped it.',
        contentFormat: 'text',
      },
      { maxBodyLength: 60 },
    );

    // "We spoke to Acme Inc." is not a sentence, and stopping there would read as a bug.
    expect(result.text).toContain('We spoke to Acme Inc. about the change.');
  });

  it('keeps a single over-long sentence rather than emitting nothing', () => {
    const long = `${'word '.repeat(200)}end.`;
    const result = deriveArticlePost(
      { ...base, content: long, contentFormat: 'text' },
      { maxBodyLength: 50 },
    );

    // The composer knows each platform's real limit; this function does not, so it hands
    // the sentence on rather than guessing where to cut.
    expect(result.text.length).toBeGreaterThan(50);
  });

  it('caps hashtags and says that it did', () => {
    const result = deriveArticlePost({
      ...base,
      tags: ['one', 'two', 'three', 'four', 'five'],
      excerpt: 'Summary.',
    });

    expect(result.hashtags).toHaveLength(3);
    expect(result.notes.some((note) => note.includes('3 of 5'))).toBe(true);
  });

  it('drops duplicate tags that normalize to the same hashtag', () => {
    const result = deriveArticlePost({
      ...base,
      tags: ['social media', 'Social Media'],
      excerpt: 'Summary.',
    });

    expect(result.hashtags).toEqual(['#SocialMedia']);
  });

  it('includes the link in the text, not only as a field', () => {
    const result = deriveArticlePost({ ...base, excerpt: 'Summary.' });

    // Most networks have no link field at all; leaving it out of the body would mean the
    // share sends nobody to the article, which is the whole point.
    expect(result.text).toContain('https://blog.example.com/latency');
    expect(result.linkUrl).toBe('https://blog.example.com/latency');
  });

  it('omits the link when asked, and says so', () => {
    const result = deriveArticlePost({ ...base, excerpt: 'Summary.' }, { includeLink: false });

    expect(result.linkUrl).toBeNull();
    expect(result.text).not.toContain('blog.example.com');
    expect(result.notes.some((note) => note.includes('Left the link out'))).toBe(true);
  });

  it('degrades to headline and link when the article has no prose', () => {
    const result = deriveArticlePost({ title: 'A headline', url: 'https://example.com/x' });

    expect(result.source).toBe('title_only');
    expect(result.text).toContain('A headline');
    expect(result.text).toContain('https://example.com/x');
  });

  it('strips markup rather than posting it', () => {
    const result = deriveArticlePost({
      ...base,
      content: '<p>Real text.</p><script>alert(1)</script>',
    });

    expect(result.text).not.toContain('<p>');
    expect(result.text).not.toContain('alert');
  });
});

describe('toHashtag', () => {
  it('camel-cases multi-word tags so they stay readable', () => {
    expect(toHashtag('social media marketing')).toBe('#SocialMediaMarketing');
  });

  it('leaves a single word’s capitalization to the author', () => {
    // Title-casing would turn their `WordPress` into `Wordpress`.
    expect(toHashtag('WordPress')).toBe('#WordPress');
  });

  it('strips punctuation a network would reject', () => {
    expect(toHashtag('c#/.net!')).toBe('#cnet');
  });

  it('returns null for a tag with nothing usable left', () => {
    expect(toHashtag('!!!')).toBeNull();
    expect(toHashtag('   ')).toBeNull();
  });
});
