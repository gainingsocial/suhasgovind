import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OUTCOME,
  SUGGESTED_POLICIES,
  evaluatePolicy,
  ruleMatches,
  type AgentPolicyRule,
  type ProposedAction,
} from './policy.js';

/**
 * The agent policy engine (plan §51, Phase 9).
 *
 * This is the code that decides whether a stranger's brand posts something nobody
 * approved. Every default and every tie-break below is asserted, because the failure modes
 * are asymmetric: a wrongly-held post is somebody waiting, and a wrongly-allowed one is a
 * customer discovering a post they never agreed to.
 */

const rule = (overrides: Partial<AgentPolicyRule> = {}): AgentPolicyRule => ({
  id: 'pol_1',
  name: 'Test rule',
  priority: 0,
  effect: 'allow',
  actions: ['*'],
  providers: [],
  agentIdentityId: null,
  conditions: {},
  requiredApproverRole: 'admin',
  reasonCode: null,
  disabled: false,
  ...overrides,
});

const action = (overrides: Partial<ProposedAction> = {}): ProposedAction => ({
  action: 'posts:create',
  agentIdentityId: 'agt_1',
  provider: 'linkedin',
  ...overrides,
});

describe('the default when nothing matches', () => {
  it('requires approval rather than allowing (plan P20)', () => {
    // An organization that has never opened the governance screen must not have an agent
    // publishing to their customers' accounts unsupervised.
    expect(evaluatePolicy([], action())).toEqual(DEFAULT_OUTCOME);
    expect(DEFAULT_OUTCOME.decision).toBe('requires_approval');
  });

  it('requires approval rather than denying', () => {
    // Denying by default would make an unconfigured agent useless and push people toward a
    // blanket `allow: *` to get anything working — worse than no engine at all, because it
    // looks configured.
    expect(DEFAULT_OUTCOME.decision).not.toBe('denied');
  });

  it('names why, so an operator can act on it', () => {
    expect(DEFAULT_OUTCOME.reasonCode).toBe('NO_POLICY_CONFIGURED');
    expect(DEFAULT_OUTCOME.requiredApproverRole).toBe('admin');
  });

  it('applies when every matching rule is disabled', () => {
    const outcome = evaluatePolicy([rule({ effect: 'allow', disabled: true })], action());
    expect(outcome.decision).toBe('requires_approval');
  });
});

describe('matching', () => {
  it('matches an empty action list as "no restriction stated"', () => {
    // A rule saying `{ effect: 'deny', actions: [] }` should not have to enumerate every
    // action in existence to work.
    expect(ruleMatches(rule({ actions: [] }), action())).toBe(true);
  });

  it('matches a wildcard', () => {
    expect(ruleMatches(rule({ actions: ['*'] }), action({ action: 'anything:at:all' }))).toBe(true);
  });

  it('does not match a different action', () => {
    expect(ruleMatches(rule({ actions: ['posts:delete'] }), action())).toBe(false);
  });

  it('narrows by provider', () => {
    const linkedInOnly = rule({ providers: ['linkedin'] });

    expect(ruleMatches(linkedInOnly, action({ provider: 'linkedin' }))).toBe(true);
    expect(ruleMatches(linkedInOnly, action({ provider: 'instagram' }))).toBe(false);
  });

  it('applies an agent-specific rule only to that agent', () => {
    const scoped = rule({ agentIdentityId: 'agt_1' });

    expect(ruleMatches(scoped, action({ agentIdentityId: 'agt_1' }))).toBe(true);
    expect(ruleMatches(scoped, action({ agentIdentityId: 'agt_2' }))).toBe(false);
  });

  it('applies an unscoped rule to every agent', () => {
    expect(ruleMatches(rule({ agentIdentityId: null }), action({ agentIdentityId: 'agt_9' }))).toBe(
      true,
    );
  });

  it('ignores a disabled rule entirely', () => {
    expect(ruleMatches(rule({ disabled: true }), action())).toBe(false);
  });
});

describe('conditions', () => {
  it('matches a post type', () => {
    const reels = rule({ conditions: { post_types: ['reel'] } });

    expect(ruleMatches(reels, action({ postType: 'reel' }))).toBe(true);
    expect(ruleMatches(reels, action({ postType: 'image' }))).toBe(false);
    // An action with no post type cannot satisfy a rule that names one.
    expect(ruleMatches(reels, action())).toBe(false);
  });

  it('matches when any named topic is present', () => {
    const sensitive = rule({ conditions: { topics: ['political', 'medical'] } });

    expect(ruleMatches(sensitive, action({ topics: ['product', 'political'] }))).toBe(true);
    expect(ruleMatches(sensitive, action({ topics: ['product'] }))).toBe(false);
    expect(ruleMatches(sensitive, action({ topics: [] }))).toBe(false);
  });

  it('distinguishes requiring media from requiring its absence', () => {
    expect(ruleMatches(rule({ conditions: { has_media: true } }), action({ hasMedia: true }))).toBe(
      true,
    );
    expect(ruleMatches(rule({ conditions: { has_media: true } }), action({ hasMedia: false }))).toBe(
      false,
    );
    expect(ruleMatches(rule({ conditions: { has_media: false } }), action())).toBe(true);
  });

  it('narrows to specific profiles', () => {
    const scoped = rule({ conditions: { profile_ids: ['pro_a'] } });

    expect(ruleMatches(scoped, action({ profileId: 'pro_a' }))).toBe(true);
    expect(ruleMatches(scoped, action({ profileId: 'pro_b' }))).toBe(false);
  });

  it('distinguishes immediate publishing from scheduled', () => {
    const now = rule({ conditions: { immediate: true } });

    expect(ruleMatches(now, action({ immediate: true }))).toBe(true);
    expect(ruleMatches(now, action({ immediate: false }))).toBe(false);
  });

  it('requires every stated condition, not any of them', () => {
    const both = rule({ conditions: { post_types: ['reel'], topics: ['political'] } });

    expect(ruleMatches(both, action({ postType: 'reel', topics: ['political'] }))).toBe(true);
    expect(ruleMatches(both, action({ postType: 'reel', topics: ['product'] }))).toBe(false);
    expect(ruleMatches(both, action({ postType: 'image', topics: ['political'] }))).toBe(false);
  });
});

describe('precedence', () => {
  it('lets the highest priority win', () => {
    const outcome = evaluatePolicy(
      [
        rule({ id: 'low', priority: 1, effect: 'deny' }),
        rule({ id: 'high', priority: 10, effect: 'allow' }),
      ],
      action(),
    );

    expect(outcome).toMatchObject({ decision: 'allowed', ruleId: 'high' });
  });

  it('breaks a priority tie toward the more restrictive rule', () => {
    // Two rules at the same priority is a misconfiguration. Resolving it the other way
    // would let an agent publish under a rule somebody believed they had overridden.
    const outcome = evaluatePolicy(
      [
        rule({ id: 'permissive', priority: 5, effect: 'allow' }),
        rule({ id: 'restrictive', priority: 5, effect: 'deny' }),
      ],
      action(),
    );

    expect(outcome).toMatchObject({ decision: 'denied', ruleId: 'restrictive' });
  });

  it('ranks require_approval above allow in a tie', () => {
    const outcome = evaluatePolicy(
      [
        rule({ id: 'a', priority: 5, effect: 'allow' }),
        rule({ id: 'b', priority: 5, effect: 'require_approval' }),
      ],
      action(),
    );

    expect(outcome.ruleId).toBe('b');
  });

  it('is independent of the order rules arrive in', () => {
    const rules = [
      rule({ id: 'a', priority: 5, effect: 'allow' }),
      rule({ id: 'b', priority: 5, effect: 'deny' }),
    ];

    expect(evaluatePolicy(rules, action()).ruleId).toBe('b');
    expect(evaluatePolicy([...rules].reverse(), action()).ruleId).toBe('b');
  });

  it('lets a high-priority allow override a lower-priority deny', () => {
    // Priority is the escape hatch: an explicit "this agent may publish to LinkedIn" has
    // to be able to beat a general "publishing needs approval".
    const outcome = evaluatePolicy(
      [
        rule({ id: 'general', priority: 10, effect: 'require_approval', actions: ['posts:create'] }),
        rule({
          id: 'linkedin',
          priority: 50,
          effect: 'allow',
          actions: ['posts:create'],
          providers: ['linkedin'],
        }),
      ],
      action({ provider: 'linkedin' }),
    );

    expect(outcome).toMatchObject({ decision: 'allowed', ruleId: 'linkedin' });
  });

  it('leaves other providers on the general rule', () => {
    const rules = [
      rule({ id: 'general', priority: 10, effect: 'require_approval', actions: ['posts:create'] }),
      rule({
        id: 'linkedin',
        priority: 50,
        effect: 'allow',
        actions: ['posts:create'],
        providers: ['linkedin'],
      }),
    ];

    expect(evaluatePolicy(rules, action({ provider: 'instagram' }))).toMatchObject({
      decision: 'requires_approval',
      ruleId: 'general',
    });
  });
});

describe('the outcome an operator reads', () => {
  it('names the rule that decided, not just the verdict', () => {
    // "You cannot do this" is a dead end. "Rule 'Reels need sign-off' held this for an
    // admin" is something an operator can act on and an agent can explain.
    const outcome = evaluatePolicy(
      [rule({ id: 'pol_reels', name: 'Reels need sign-off', effect: 'require_approval' })],
      action(),
    );

    expect(outcome).toMatchObject({ ruleId: 'pol_reels', ruleName: 'Reels need sign-off' });
  });

  it('carries the rule’s own reason code when it has one', () => {
    const outcome = evaluatePolicy(
      [rule({ effect: 'require_approval', reasonCode: 'SENSITIVE_TOPIC' })],
      action(),
    );

    expect(outcome.reasonCode).toBe('SENSITIVE_TOPIC');
  });

  it('falls back to a code derived from the effect', () => {
    expect(evaluatePolicy([rule({ effect: 'deny' })], action()).reasonCode).toBe('POLICY_DENIED');
  });

  it('names an approver only when somebody can actually approve', () => {
    // Returning a role alongside `denied` would suggest a person could override it, and no
    // such person exists.
    expect(
      evaluatePolicy([rule({ effect: 'deny', requiredApproverRole: 'owner' })], action())
        .requiredApproverRole,
    ).toBeNull();

    expect(
      evaluatePolicy(
        [rule({ effect: 'require_approval', requiredApproverRole: 'owner' })],
        action(),
      ).requiredApproverRole,
    ).toBe('owner');
  });
});

describe('the suggested starter policies', () => {
  const withIds = SUGGESTED_POLICIES.map((policy, index) => ({
    ...policy,
    id: `pol_${index}`,
    agentIdentityId: null,
  }));

  it('lets an agent draft freely', () => {
    expect(evaluatePolicy(withIds, action({ action: 'posts:draft' })).decision).toBe('allowed');
  });

  it('holds publishing for a person', () => {
    expect(evaluatePolicy(withIds, action({ action: 'posts:create' })).decision).toBe(
      'requires_approval',
    );
  });

  it('refuses deletion outright', () => {
    const outcome = evaluatePolicy(withIds, action({ action: 'posts:delete' }));

    expect(outcome.decision).toBe('denied');
    expect(outcome.reasonCode).toBe('DELETION_IS_NOT_DELEGATED');
  });

  it('holds a sensitive topic even when the action would otherwise be allowed', () => {
    // The highest-priority rule, so it beats the permissive drafting rule beneath it.
    const outcome = evaluatePolicy(
      withIds,
      action({ action: 'posts:draft', topics: ['political'] }),
    );

    expect(outcome).toMatchObject({ decision: 'requires_approval', reasonCode: 'SENSITIVE_TOPIC' });
  });

  it('does not hold ordinary content as sensitive', () => {
    expect(
      evaluatePolicy(withIds, action({ action: 'posts:draft', topics: ['product', 'launch'] }))
        .decision,
    ).toBe('allowed');
  });
});
