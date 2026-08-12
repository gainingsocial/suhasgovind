/**
 * The agent policy engine (plan §51, Phase 9).
 *
 * Answers one question: *may this agent do this thing, right now, unsupervised?*
 *
 * Pure and synchronous. Nothing here reads a database or calls a model — it takes the
 * rules and the attributes of a proposed action and returns a decision. That matters
 * because this is the code that decides whether a stranger's brand posts something nobody
 * approved, and code with that consequence should be exhaustively testable without a
 * fixture.
 */

export type PolicyEffect = 'allow' | 'require_approval' | 'deny';

export type PolicyDecision = 'allowed' | 'requires_approval' | 'denied';

/**
 * Restrictiveness, used to break priority ties and to pick a winner among equals.
 *
 * A tie resolves toward the more restrictive rule. Two rules left at the same priority is
 * a misconfiguration, and the failure mode of resolving it the other way is an agent
 * publishing under a rule somebody thought they had overridden.
 */
const EFFECT_RANK: Record<PolicyEffect, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

export interface AgentPolicyRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly effect: PolicyEffect;
  /** Actions covered. `['*']` or an empty list covers everything. */
  readonly actions: readonly string[];
  /** Providers covered. Empty covers all of them. */
  readonly providers: readonly string[];
  /** Null applies to every agent; otherwise only this one. */
  readonly agentIdentityId: string | null;
  readonly conditions: PolicyConditions;
  readonly requiredApproverRole: string;
  readonly reasonCode: string | null;
  readonly disabled: boolean;
}

/**
 * Extra conditions a rule may place on an action.
 *
 * Every field is optional and absent means "do not care". A rule that specified nothing
 * matching everything is the useful default — `{ effect: 'deny', actions: ['posts:delete'] }`
 * should not need to enumerate every post type in existence to work.
 */
export interface PolicyConditions {
  /** e.g. `['reel', 'story']`. Matches when the action's post type is one of these. */
  readonly post_types?: readonly string[];
  /** Matches when the action touches any of these topics. */
  readonly topics?: readonly string[];
  /** Matches only when media is present, or only when it is absent. */
  readonly has_media?: boolean;
  /** Matches when the action targets one of these profiles. */
  readonly profile_ids?: readonly string[];
  /** Matches when the action would publish immediately rather than to a schedule. */
  readonly immediate?: boolean;
}

/** What the agent is proposing to do. */
export interface ProposedAction {
  readonly action: string;
  readonly agentIdentityId: string;
  readonly provider?: string | null;
  readonly profileId?: string | null;
  readonly postType?: string | null;
  /** Topics detected in the content. Supplied by the caller; this engine does not classify. */
  readonly topics?: readonly string[];
  readonly hasMedia?: boolean;
  readonly immediate?: boolean;
}

export interface PolicyOutcome {
  readonly decision: PolicyDecision;
  /** The rule that decided. Null when the default applied. */
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly reasonCode: string;
  readonly requiredApproverRole: string | null;
}

/**
 * What happens when no rule matches (plan P20 — "automation defaults to review").
 *
 * Review, not allow, and not deny.
 *
 * Denying would make an unconfigured agent useless and push people toward a blanket
 * `allow: *` rule to get anything working — which is worse than no policy engine at all,
 * because it looks configured. Allowing would mean an organization that has never opened
 * the governance screen has an agent publishing to their customers' accounts unsupervised.
 *
 * Review is the only default where the failure mode is somebody waiting rather than
 * somebody discovering a post they never approved.
 */
export const DEFAULT_OUTCOME: PolicyOutcome = {
  decision: 'requires_approval',
  ruleId: null,
  ruleName: null,
  reasonCode: 'NO_POLICY_CONFIGURED',
  requiredApproverRole: 'admin',
};

function matchesList(candidates: readonly string[], value: string | null | undefined): boolean {
  // An empty list means "no restriction stated", which matches everything.
  if (candidates.length === 0) return true;
  if (candidates.includes('*')) return true;
  return value !== null && value !== undefined && candidates.includes(value);
}

function matchesConditions(conditions: PolicyConditions, action: ProposedAction): boolean {
  if (conditions.post_types && conditions.post_types.length > 0) {
    if (!action.postType || !conditions.post_types.includes(action.postType)) return false;
  }

  if (conditions.topics && conditions.topics.length > 0) {
    const topics = action.topics ?? [];
    if (!conditions.topics.some((topic) => topics.includes(topic))) return false;
  }

  if (conditions.has_media !== undefined) {
    if ((action.hasMedia ?? false) !== conditions.has_media) return false;
  }

  if (conditions.profile_ids && conditions.profile_ids.length > 0) {
    if (!action.profileId || !conditions.profile_ids.includes(action.profileId)) return false;
  }

  if (conditions.immediate !== undefined) {
    if ((action.immediate ?? false) !== conditions.immediate) return false;
  }

  return true;
}

export function ruleMatches(rule: AgentPolicyRule, action: ProposedAction): boolean {
  if (rule.disabled) return false;

  // A rule naming an agent applies only to that one. A rule naming none applies to all.
  if (rule.agentIdentityId !== null && rule.agentIdentityId !== action.agentIdentityId) {
    return false;
  }

  if (!matchesList(rule.actions, action.action)) return false;
  if (!matchesList(rule.providers, action.provider)) return false;

  return matchesConditions(rule.conditions, action);
}

/**
 * Decide whether an action may proceed.
 *
 * Highest priority wins. Among equal priorities the most restrictive wins, so a
 * misconfiguration fails safe. When nothing matches, {@link DEFAULT_OUTCOME} applies.
 *
 * The winning rule is returned, not just the verdict. "You cannot do this" is a dead end;
 * "rule 'Reels need sign-off' held this for an admin" is something an operator can act on
 * and an agent can explain to whoever asked it.
 */
export function evaluatePolicy(
  rules: readonly AgentPolicyRule[],
  action: ProposedAction,
): PolicyOutcome {
  let winner: AgentPolicyRule | null = null;

  for (const rule of rules) {
    if (!ruleMatches(rule, action)) continue;

    if (
      winner === null ||
      rule.priority > winner.priority ||
      (rule.priority === winner.priority && EFFECT_RANK[rule.effect] > EFFECT_RANK[winner.effect])
    ) {
      winner = rule;
    }
  }

  if (!winner) return DEFAULT_OUTCOME;

  const decision: PolicyDecision =
    winner.effect === 'allow'
      ? 'allowed'
      : winner.effect === 'deny'
        ? 'denied'
        : 'requires_approval';

  return {
    decision,
    ruleId: winner.id,
    ruleName: winner.name,
    reasonCode: winner.reasonCode ?? defaultReasonCode(winner.effect),
    // Only meaningful when somebody has to approve. Returning a role alongside `denied`
    // would suggest a person could override it, and no such person exists.
    requiredApproverRole: winner.effect === 'require_approval' ? winner.requiredApproverRole : null,
  };
}

function defaultReasonCode(effect: PolicyEffect): string {
  switch (effect) {
    case 'allow':
      return 'POLICY_ALLOWED';
    case 'deny':
      return 'POLICY_DENIED';
    case 'require_approval':
      return 'POLICY_REQUIRES_APPROVAL';
  }
}

/**
 * The starter rules a new organization gets (plan Phase 9's own examples).
 *
 * Shipped as a suggestion an operator adopts and edits, never applied automatically.
 * Silently installing rules would mean an organization's governance says something nobody
 * in it chose — and the first time it blocks something, the honest answer to "who decided
 * that?" would be "we did, on your behalf, without asking".
 */
export const SUGGESTED_POLICIES: readonly Omit<AgentPolicyRule, 'id' | 'agentIdentityId'>[] = [
  {
    name: 'Agents may draft anything',
    priority: 0,
    effect: 'allow',
    actions: ['posts:draft', 'posts:preflight', 'posts:compose'],
    providers: [],
    conditions: {},
    requiredApproverRole: 'admin',
    reasonCode: 'DRAFTING_IS_UNRESTRICTED',
    disabled: false,
  },
  {
    name: 'Publishing needs sign-off',
    priority: 10,
    effect: 'require_approval',
    actions: ['posts:create'],
    providers: [],
    conditions: {},
    requiredApproverRole: 'admin',
    reasonCode: 'PUBLISHING_REQUIRES_APPROVAL',
    disabled: false,
  },
  {
    name: 'Agents may not delete published posts',
    priority: 100,
    effect: 'deny',
    actions: ['posts:delete'],
    providers: [],
    conditions: {},
    requiredApproverRole: 'admin',
    reasonCode: 'DELETION_IS_NOT_DELEGATED',
    disabled: false,
  },
  {
    name: 'Sensitive topics always need a person',
    priority: 200,
    effect: 'require_approval',
    actions: ['*'],
    providers: [],
    conditions: { topics: ['political', 'medical', 'financial_advice', 'legal_advice'] },
    requiredApproverRole: 'admin',
    reasonCode: 'SENSITIVE_TOPIC',
    disabled: false,
  },
];
