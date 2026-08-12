import type { CapabilityConstraints } from '@gs/contracts/capabilities';

import type { FitDecision } from '../media/fit-plan.js';

/**
 * Deterministic text adaptation for the Smart Universal Composer (plan §63C, P16, P17).
 *
 * One canonical piece of writing has to become a compliant post on every selected network,
 * without the author learning that Bluesky allows 300 characters and LinkedIn allows 3,000.
 *
 * Everything here is **mechanical**: shortening at a boundary the author already wrote,
 * moving hashtags, dropping a link the platform ignores anyway. Nothing rewrites, rephrases
 * or generates. Rewording belongs to the Content Intelligence layer (plan §63R), where it
 * is a model call the author reviews — not a silent transformation buried in a publish.
 *
 * The distinction is the same one Smart Media Auto-Fit draws: a change that preserves what
 * was written may be automatic, and a change that decides what it *says* may not.
 */

export type TextAdaptationKind =
  /** Cut at a sentence or word boundary the author already wrote. */
  | 'truncate'
  /** Hashtags moved out of the body — to a first comment, or dropped from the tail. */
  | 'move_hashtags'
  /** A link removed because the platform does not render or count it usefully. */
  | 'strip_link'
  /** Mentions removed because the platform cannot resolve them. */
  | 'strip_mentions';

export interface TextAdaptation {
  readonly kind: TextAdaptationKind;
  readonly decision: FitDecision;
  readonly reason: string;
}

export interface TextFitResult {
  /** What would actually be published. Equal to the input when nothing was needed. */
  readonly text: string;
  /** Hashtags lifted out of the body, in the order they appeared. */
  readonly extractedHashtags: readonly string[];
  readonly adaptations: readonly TextAdaptation[];
  readonly decision: FitDecision;
}

/** Unicode-aware, so an emoji counts as one character rather than two. */
export function graphemeLength(text: string): number {
  return [...text].length;
}

/**
 * Trim to `limit` characters at the last boundary before it.
 *
 * Sentence end first, then word end, then a hard cut. Cutting mid-word produces "the annual
 * confe" — visibly broken in a way that reads as a bug rather than an edit, and the first
 * thing a reader notices about the post.
 *
 * The hard cut is the last resort for text with no spaces at all, where there is no
 * boundary to find and the alternative is publishing nothing.
 */
export function truncateAtBoundary(text: string, limit: number): string {
  const characters = [...text];
  if (characters.length <= limit) return text;

  const window = characters.slice(0, limit).join('');

  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('\n'),
  );
  /**
   * Two different thresholds, and the gap between them is the point.
   *
   * A sentence cut always yields something well-formed, so the only risk is losing more
   * content than necessary — 40% is enough to reject "Hi." standing in for a paragraph.
   * A word cut yields a dangling fragment, which is the outcome this whole function exists
   * to avoid, so it has to clear a higher bar before being worth taking.
   *
   * Using one threshold for both is what makes a 40-character limit over "First sentence
   * here. Second sentence follows…" reject the clean cut at 20 and produce the fragment
   * "…here. Second sentence" instead — strictly worse by the function's own standard.
   */
  if (sentenceEnd > limit * 0.4) return window.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(' ');
  if (wordEnd > limit * 0.5) return window.slice(0, wordEnd).trim();

  return window.trim();
}

const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;
const MENTION_PATTERN = /@[\p{L}\p{N}_.]+/gu;

export function extractHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_PATTERN)].map((match) => match[0]);
}

/**
 * Remove the trailing block of hashtags, leaving the body intact.
 *
 * Only the trailing block. A hashtag written *inside* a sentence — "we're at #CES this
 * week" — is part of the writing, and lifting it out leaves a gap mid-sentence. The block
 * at the end is the one people append as metadata, and the one platforms want moved to a
 * first comment.
 */
export function stripTrailingHashtags(text: string): { body: string; hashtags: string[] } {
  const trailing = /(?:\s*#[\p{L}\p{N}_]+)+\s*$/u.exec(text);
  if (!trailing) return { body: text, hashtags: [] };

  return {
    body: text.slice(0, trailing.index).trimEnd(),
    hashtags: extractHashtags(trailing[0]),
  };
}

export interface TextFitInput {
  readonly text: string;
  readonly linkUrl: string | null;
  /** `exact` reports what is wrong; `optimize` adapts what it safely can (plan §63B). */
  readonly mode: 'exact' | 'optimize';
  /** True when the platform accepts hashtags in a first comment instead of the body. */
  readonly supportsFirstComment?: boolean;
}

/**
 * Fit one piece of writing to one destination's constraints.
 *
 * In `exact` mode nothing is changed: every problem is reported at the decision level it
 * deserves so the author can decide. In `optimize` mode the mechanical fixes are applied
 * and reported — never silently (plan §18 item 11).
 */
export function planTextFit(
  input: TextFitInput,
  constraints: CapabilityConstraints,
): TextFitResult {
  const adaptations: TextAdaptation[] = [];
  let text = input.text;
  let extractedHashtags: string[] = [];

  const limit = constraints.max_text_length;
  const maxHashtags = constraints.max_hashtags;

  // ---- hashtags -----------------------------------------------------------
  const hashtags = extractHashtags(text);

  if (maxHashtags !== null && hashtags.length > maxHashtags) {
    if (input.mode === 'optimize') {
      const stripped = stripTrailingHashtags(text);

      // Only helps if the excess is genuinely in the trailing block. Hashtags woven
      // through the writing cannot be removed without editing the writing.
      if (stripped.hashtags.length >= hashtags.length - maxHashtags) {
        text = stripped.body;
        extractedHashtags = stripped.hashtags;
        adaptations.push({
          kind: 'move_hashtags',
          decision: 'SAFE_AUTOFIX',
          reason: input.supportsFirstComment
            ? `This platform allows ${maxHashtags} hashtags; ${stripped.hashtags.length} moved to a first comment.`
            : `This platform allows ${maxHashtags} hashtags; ${stripped.hashtags.length} removed from the end of the post.`,
        });
      } else {
        adaptations.push({
          kind: 'move_hashtags',
          decision: 'USER_DECISION_REQUIRED',
          reason: `This platform allows ${maxHashtags} hashtags and the post has ${hashtags.length}, written through the text. Choose which to keep.`,
        });
      }
    } else {
      adaptations.push({
        kind: 'move_hashtags',
        decision: 'USER_DECISION_REQUIRED',
        reason: `This platform allows ${maxHashtags} hashtags; the post has ${hashtags.length}.`,
      });
    }
  }

  // ---- mentions -----------------------------------------------------------
  const mentions = [...text.matchAll(MENTION_PATTERN)];
  if (constraints.max_mentions !== null && mentions.length > constraints.max_mentions) {
    // Never automatic, in either mode. A mention is a person, and deciding which people to
    // drop from a post is not a formatting decision.
    adaptations.push({
      kind: 'strip_mentions',
      decision: 'USER_DECISION_REQUIRED',
      reason: `This platform allows ${constraints.max_mentions} mentions; the post has ${mentions.length}. Choose which to keep.`,
    });
  }

  // ---- length -------------------------------------------------------------
  // Checked after hashtag removal, since removing them may already have solved it.
  if (limit !== null) {
    const linkCost = input.linkUrl ? graphemeLength(input.linkUrl) + 1 : 0;
    const available = limit - linkCost;

    if (graphemeLength(text) > available) {
      if (input.mode === 'optimize') {
        const shortened = truncateAtBoundary(text, available);
        const lost = graphemeLength(text) - graphemeLength(shortened);

        text = shortened;
        adaptations.push({
          kind: 'truncate',
          /**
           * Shortening is reported for review, never applied silently.
           *
           * Cutting at a boundary the author wrote preserves the words that remain, but it
           * still removes some — and the removed part may be the point. This is where the
           * media rule's logic lands on text: mechanical enough to *propose*, editorial
           * enough to show first.
           */
          decision: 'REVIEW_AUTOFIX',
          reason: `This platform allows ${limit} characters; ${lost} shortened from the end. Review before publishing.`,
        });
      } else {
        adaptations.push({
          kind: 'truncate',
          decision: 'USER_DECISION_REQUIRED',
          reason: `This platform allows ${limit} characters; the post has ${graphemeLength(text)}.`,
        });
      }
    }
  }

  const decision = adaptations.reduce<FitDecision>((worst, adaptation) => {
    const rank: Record<FitDecision, number> = {
      PASS: 0,
      SAFE_AUTOFIX: 1,
      REVIEW_AUTOFIX: 2,
      USER_DECISION_REQUIRED: 3,
      UNSUPPORTED: 4,
    };
    return rank[adaptation.decision] > rank[worst] ? adaptation.decision : worst;
  }, 'PASS');

  return { text, extractedHashtags, adaptations, decision };
}
