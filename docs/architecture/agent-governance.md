# Agent governance

Plan §51 and Phase 9. What an agent may do on a customer's social accounts, decided by
rules the customer wrote, with a human in the loop where they asked for one.

The premise: an agent is not a script holding a key. It is an actor whose authority has to
be describable, auditable and revocable independently of whichever credential it happens to
be using today.

## The default is review

An organization that has configured nothing gets an agent that can draft and cannot
publish. This is plan P20 — *automation defaults to review* — and it is the single most
consequential line in the module.

The other two defaults were both considered and both are worse:

- **Deny by default** makes an unconfigured agent useless, which pushes people toward a
  blanket `allow: *` rule just to get anything working. That is worse than having no policy
  engine at all, because it *looks* configured.
- **Allow by default** means an organization that has never opened the governance screen
  has an agent publishing to their customers' accounts unsupervised.

Review is the only default whose failure mode is somebody waiting, rather than somebody
discovering a post they never approved.

## Rules are rows

The rules customers actually want are specific to them:

```
Agents may draft anything.
Publishing needs sign-off.
Agents may auto-publish to LinkedIn.
Instagram Reels require approval.
Anything political requires approval.
Agents may not delete posts.
```

Encoding those as branches would mean a deploy per customer. A policy is
`(effect, actions, providers, conditions, priority)`, scoped to an organization, project,
environment or single agent.

## Evaluation

Pure, synchronous, and in `@gs/domain`. No database, no model call. This is the code that
decides whether a stranger's brand posts something nobody approved, and code with that
consequence should be exhaustively testable without a fixture.

1. Discard rules that do not match the action, the provider, the conditions, or the agent.
2. Highest `priority` wins.
3. **On a tie, the more restrictive effect wins** — `deny` > `require_approval` > `allow`.
4. If nothing matches, review.

Step 3 matters more than it reads. Two rules at the same priority is a misconfiguration,
and resolving it the other way would let an agent publish under a rule somebody believed
they had overridden. Evaluation is also order-independent: the same rule set produces the
same decision however the rows come back.

Priority is the escape hatch that makes the model usable. A specific
`allow posts:create on linkedin @ 50` beats a general `require_approval posts:create @ 10`,
while every other provider stays on the general rule.

## The outcome names the rule

```json
{
  "decision": "requires_approval",
  "ruleId": "pol_…",
  "ruleName": "Reels need sign-off",
  "reasonCode": "SENSITIVE_TOPIC",
  "requiredApproverRole": "admin"
}
```

"You cannot do this" is a dead end. "Rule *Reels need sign-off* held this for an admin" is
something an operator can act on and an agent can explain to whoever asked it.

`requiredApproverRole` is null on `denied`. Naming an approver there would suggest somebody
could override it, and no such person exists.

## Refusals are recorded too

`agent_actions` gets a row for every decision — allowed, held or denied.

Storing only the permitted ones would erase the evidence of an agent repeatedly attempting
something it should not, which is the signal most worth having and the one nobody thinks to
record until they need it. A partial index makes "what has been refused lately" cheap, since
that is the query an operator actually runs.

## Approvals

```
GET  /v1/approvals?environment_id=env_…
POST /v1/approvals/{id}/decide   { "decision": "approved" }
```

Authenticated by a **dashboard session, never an API key**. An approval an agent could grant
itself is not an approval — and agents authenticate with API keys, so allowing one here
would make the entire policy engine decorative.

**One live request per subject**, enforced by a partial unique index. Two pending approvals
for the same post would let one approver accept while another rejects, with nothing deciding
which wins. A retried request joins the existing approval rather than opening a competitor.

**Decided exactly once.** The update is conditional on `status = 'pending'`. Two approvers
acting at once is the normal case — the notification goes to a team — and without the
condition the second write would silently overwrite the first, so a rejection could land on
top of an approval that had already released the post.

**The required role travels on the request**, not re-derived at decision time. Editing a
policy later must not retroactively lower the bar on work already held under the old one.

**Expiry is mandatory and not nullable.** An approval that waits forever is a post that
silently never goes out — the worst failure this product has, because nothing surfaces it.
The reconciler expires stale requests, which at least produces a state a customer can alert
on.

## What is deliberately not here yet

**Topic classification.** The engine takes `topics` as an input and does not compute them.
Deciding that a post is "political" is a model call with its own failure modes, and putting
it inside a synchronous policy evaluator would make the most consequential code path in the
system depend on an inference. The classifier belongs to Content Intelligence, and it feeds
this rather than living in it.

**Scoped MCP tokens** (plan §51). Short-lived tokens narrowed to specific profiles, actions
and an expiry are the natural next layer, and they sit on top of this rather than replacing
it: a token bounds what an agent can *attempt*, and policy decides what it may *do*.

**`waitForEvent` workflows.** Plan Phase 9 suggests Cloudflare Workflows for approval waits.
The current design holds the post in the database instead, which survives a Workflow being
redeployed and does not tie an approval's lifetime to a runtime primitive.

## Related

- Plan §51, Phase 9, P20
- [The MCP layer](./mcp.md)
