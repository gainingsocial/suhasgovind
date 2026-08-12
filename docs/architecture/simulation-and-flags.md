# Simulation mode and feature flags

Plan §49 and §45. Two switches, opposite defaults, and the defaults are the load-bearing
part of each.

## Simulation mode

An environment is either `live` or `simulate`:

```
GET   /v1/environments                  → mode: "live" | "simulate"
PATCH /v1/environments/{id}  { "mode": "simulate" }
```

In `simulate`, the **entire publishing pipeline runs** — idempotency reservation, tenant
ownership, preflight, the target lease, connection health, content and override resolution,
media resolution and signing, the state machine, post status recalculation, and the outbound
customer webhooks. The single step that does not happen is the provider call.

### The state machine is identical, and that is the point

A simulated target reaches `published`. The post reaches `published`. `post.published`
fires to your webhook endpoint.

This is deliberate. A test mode whose states differ from production forces every customer
to write a branch in order to test themselves — which defeats the entire purpose of having
one. You want to exercise *your* webhook handler, *your* polling loop, *your* partial-success
logic, against the same shapes production will send.

What tells the two apart:

| Field                          | Simulated              | Real                |
| ------------------------------ | ---------------------- | ------------------- |
| `targets[].simulated`          | `true`                 | `false`             |
| `targets[].external_post_id`   | `sim_ptg_...`          | the provider's id   |
| `targets[].external_url`       | `null`                 | a real URL          |
| `mode` on the post             | `"simulate"`           | `"live"`            |

`external_url` stays null on purpose. A link that 404s is worse than no link, because it is
the one field a reader would use to check whether the post is real.

### It needs no working credential

A simulated publish decrypts nothing and resolves no platform application. That is not an
optimization — it is what makes the mode useful. A developer rehearsing a launch, or an
agent dry-running a plan, must get a real answer about whether the *content* is publishable
even when the connection's token expired last week or the platform's approval has not landed
yet. Requiring a working credential would make simulation useless in exactly the situations
it exists for.

Connection health is still checked. A revoked connection is a real fact about whether this
post could publish, and hiding it would make the rehearsal a lie.

### `simulate` is not `test`

They are independent:

- a `test` environment may publish to a real platform sandbox account;
- a `live` environment can be switched to `simulate` during an incident, stopping all
  outbound posting without taking the API down.

### Where the mode is read

Per publish, from the database — never from the queue message and never from the request.

A queue message can be days old; a scheduled post is the normal case. Simulation switched on
*after* a message was enqueued must still be honoured, or the switch does not stop anything
already in flight — which is exactly the moment somebody reaches for it.

And it is never accepted from a request body. A caller who could ask for `mode: live` could
escalate themselves out of a sandbox, which is the one thing a sandbox is for.

## Feature flags

Scope precedence, most specific wins:

```
environment  →  project  →  organization  →  global
```

One query resolves all four. Flags are read on the publish path and on every capability
response, and four cascading round trips to a database a region away is not a price worth
paying for a boolean.

### Two primitives, opposite defaults

This is the part worth reading twice.

```
evaluateFlag(flag, subjectId)      absent → OFF     for rolling a new feature out
providerBlockedBy(flags, provider) absent → ALLOWED for switching a provider off
```

Two functions rather than one with a `defaultValue` parameter, because the two directions
are not a configuration detail — they are opposite failure modes:

- a rollout that defaulted **on** would ship an untested feature to everyone;
- a kill switch that defaulted **off** would take every provider down whenever the flags
  table is empty, which is its state in every environment nobody has configured.

### Kill switches

```
provider:instagram          disables Instagram entirely
provider:instagram:reels    disables Reels, leaving the rest of Instagram working
```

The more specific key wins; a provider-wide switch also stops its features. This is §45's
stated purpose: "disable a failing feature without taking down the whole provider".

A kill switch produces `PROVIDER_TEMPORARILY_DISABLED` — a **503, retryable**. Preflight
reports it up front, and the publisher re-checks it, because preflight ran when the post was
created and a scheduled post may have been waiting for weeks.

A target hitting a kill switch is **retried, not failed**. A kill switch is temporary by
definition; permanently failing every post in flight would turn a five-minute mitigation into
a day of support tickets and manual retries.

The publisher handles this outside the normalized provider-error taxonomy (plan §79) on
purpose. Nothing was attempted and no provider was contacted, so recording it as a provider
failure would corrupt the very error rates the health engine reads to decide whether the
provider is broken.

### Percentage rollouts are deterministic

`rollout_percentage` buckets on a hash of `key|subjectId`, so the same connection lands on
the same side of the split every time. A random draw per call would flip a feature on and off
between a preflight and the publish it validated — the one outcome a rollout must never
produce. Independent per key, so two 50% rollouts do not hit the same half of the population.

Without a subject there is nothing stable to hash, so a partial rollout with no subject is
off rather than random.

### A note on the uniqueness constraint

`feature_flags_scope_key` carries `NULLS NOT DISTINCT` (migration `0006`). Three of its four
columns are NULL for a global flag, and Postgres treats NULLs as distinct by default — so
without that clause the constraint did not constrain global flags at all, and every upsert
inserted a duplicate rather than updating. Two contradictory rows at the same specificity
would then resolve by physical row order.

Drizzle 0.45 cannot express the clause, so the schema declaration is deliberately weaker than
the database. Treat the migration as authoritative and review `db:generate` output rather
than applying it.

## Related

- Plan §45, §49
- [Inbound provider webhooks](./inbound-provider-webhooks.md)
- [ADR-006 — effective-once](../adr/ADR-006-effective-once.md)
