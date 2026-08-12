/**
 * Source spans and grounding (plan §63I, P18).
 *
 * The product promise is that a generated factual claim can be traced back to the source
 * it came from. That is only enforceable if the source is addressable — so normalized text
 * is split into stable, identified spans, and every claim carries the span ids that support
 * it.
 *
 * Without this, "grounded" is a hope. With it, an ungrounded claim is a validation failure
 * rather than something a reader has to notice.
 */

export interface SourceSpan {
  /** Stable within one source version. Claims reference these. */
  readonly id: string;
  readonly text: string;
  /** Character offsets into the normalized text, so a span can be highlighted. */
  readonly start: number;
  readonly end: number;
}

/**
 * Split normalized text into spans.
 *
 * Paragraph-first, then sentence, because a claim usually rests on a sentence and a
 * paragraph is too coarse to be evidence of anything specific. Splitting per word would be
 * precise and useless: nobody can verify a claim against seven scattered words.
 *
 * Ids are positional (`span_0`, `span_1`, …) and stable *within one version* of the source.
 * They deliberately do not survive the source changing — a claim grounded in span 12 of
 * yesterday's article is not grounded in span 12 of today's, and pretending otherwise is
 * exactly the failure this module exists to prevent. A changed source gets a new version
 * and a fresh extraction.
 */
export function splitIntoSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let index = 0;
  let cursor = 0;

  // Sentence boundaries followed by whitespace, plus paragraph breaks. Abbreviations will
  // occasionally split early; a span that is slightly short is a citation that is slightly
  // narrow, which is a far cheaper error than one that is slightly wrong.
  const pattern = /(?<=[.!?])\s+|\n{2,}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const chunk = text.slice(cursor, match.index).trim();
    if (chunk.length > 0) {
      spans.push({ id: `span_${index++}`, text: chunk, start: cursor, end: match.index });
    }
    cursor = match.index + match[0].length;
  }

  const tail = text.slice(cursor).trim();
  if (tail.length > 0) {
    spans.push({ id: `span_${index}`, text: tail, start: cursor, end: text.length });
  }

  return spans;
}

/** A claim the model produced, with the spans it says support it. */
export interface GroundedClaim {
  readonly text: string;
  readonly sourceSpanIds: readonly string[];
  /** Model-reported. Treated as a hint, never as permission. */
  readonly confidence?: number;
}

export type ClaimKind = 'fact' | 'statistic' | 'quote' | 'name' | 'date';

export interface GroundingFailure {
  readonly claim: string;
  readonly reason: 'no_spans_cited' | 'unknown_span' | 'quote_not_present';
}

export interface GroundingResult {
  readonly grounded: readonly GroundedClaim[];
  readonly failures: readonly GroundingFailure[];
}

/**
 * Check that every claim cites spans that actually exist.
 *
 * A model asked to cite its sources will cite `span_47` for a document with nine spans.
 * That is not a rare failure — it is the ordinary behaviour of a system generating
 * plausible tokens, and it is invisible unless something checks.
 *
 * Quotes get a stricter test: the quoted words must genuinely appear in the cited span.
 * A paraphrase presented as a quotation is the single most damaging thing this pipeline
 * could publish, because it puts words in a named person's mouth.
 */
export function verifyGrounding(
  claims: readonly GroundedClaim[],
  spans: readonly SourceSpan[],
  kind: ClaimKind = 'fact',
): GroundingResult {
  const byId = new Map(spans.map((span) => [span.id, span]));

  const grounded: GroundedClaim[] = [];
  const failures: GroundingFailure[] = [];

  for (const claim of claims) {
    if (claim.sourceSpanIds.length === 0) {
      failures.push({ claim: claim.text, reason: 'no_spans_cited' });
      continue;
    }

    const cited = claim.sourceSpanIds.map((id) => byId.get(id));
    if (cited.some((span) => span === undefined)) {
      failures.push({ claim: claim.text, reason: 'unknown_span' });
      continue;
    }

    if (kind === 'quote') {
      const haystack = cited.map((span) => span!.text).join(' ');
      if (!containsQuote(haystack, claim.text)) {
        failures.push({ claim: claim.text, reason: 'quote_not_present' });
        continue;
      }
    }

    grounded.push(claim);
  }

  return { grounded, failures };
}

/**
 * Is this quotation actually in the source?
 *
 * Whitespace and quote-mark style are normalized, because a source using curly quotes and
 * a model producing straight ones is a formatting difference, not a fabrication. Nothing
 * else is relaxed: a changed word is a changed quote.
 *
 * *Every* quote character folds to one form — curly and straight, single and double.
 * Folding only the curly ones leaves `"…"` and `'…'` as different strings, so a correctly
 * quoted line gets rejected as fabricated purely because the model chose double quotes
 * where the article used single ones.
 */
function containsQuote(haystack: string, quote: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/[‘’“”'"]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  return normalize(haystack).includes(normalize(quote));
}

/**
 * Is a draft publishable as source-grounded?
 *
 * Any ungrounded factual claim disqualifies it. Not a warning, not a confidence score —
 * plan P18 says generated factual claims must be traceable to the source, and a rule that
 * lets *some* fabrication through is not that rule.
 *
 * A draft with no factual claims at all is fine. Plenty of good social copy makes no
 * verifiable assertion, and demanding citations for "we're excited to share this" would
 * make the check meaningless by making it universal.
 */
export function isPublishableAsGrounded(results: readonly GroundingResult[]): boolean {
  return results.every((result) => result.failures.length === 0);
}
