# Creator-First Product Plan

**Status:** authoritative extension of `UNIFIED_SOCIAL_API_MASTER_BUILD_PLAN.md`.
**Date:** 2026-08-14.
**Relationship to the master plan:** this document does not replace it. Every principle,
rule and architectural decision in the master plan still holds — P1 through P19, the §85
operating rules, the §86 completion checklist. What changes is *who the product is for* and
therefore what sits on top of the engine. Where this document and the master plan disagree
about **audience, interface or packaging**, this document wins. Where they disagree about
**architecture, security or correctness**, the master plan wins.

---

## 1. The decision

The platform is built. It is excellent, and it is invisible.

Eleven phases have landed: a publishing engine with target-level state, effective-once
delivery, reconciliation, capability preflight, thirteen certified provider adapters,
analytics, a unified inbox, an MCP layer, an agent approval control plane, and a social
memory loop. All of it is reachable through a REST API and, for six of those feature areas,
through nothing else at all.

That is a developer product. Developers are roughly **2% of the money**.

This plan makes the same engine serve four audiences, in this order of commercial weight:

| Audience | What they are | Why they matter |
| --- | --- | --- |
| **Creators & influencers** | Individuals and small teams publishing daily | Volume. Millions of them, and the habit is daily |
| **Media houses & website owners** | Newsrooms, publishers, blogs, ecommerce | Money. High volume, high willingness to pay, low churn |
| **AI agents** | Autonomous systems acting on a human's behalf | The next decade's default interface |
| **Developers** | SaaS builders embedding social publishing | The moat, and the reason the engine is this good |

The engine does not change. The product on top of it does.

---

## 2. What the market actually shows

Researched 2026-08-14. Sources listed in §12.

### 2.1 The money

- Social media management software: **$33–36B in 2026**, compounding at **~16.6%**.
- Creator economy overall: **$323B in 2026**, up from $256B in 2025.
- Creator *tools and infrastructure* specifically: **$25–38B**, 8–12% of that total.

The tooling layer is where a platform like this one competes, and it is growing faster than
the creator economy it serves.

### 2.2 What everybody charges, and why it is a weakness

| Tool | Model | Entry price |
| --- | --- | --- |
| Buffer | Per channel | $6/channel/mo, $12 on Team |
| Later | Per "social set" | $25/mo |
| Publer | Per account | ~$4–8/account/mo |
| Metricool | Per brand | $18–22/mo, 5 brands |
| Blotato | Per tier, channel-capped | $29 / $97 / $499 |

Every one of them meters the thing the customer wants more of. The consistent complaint in
review after review is the same sentence in different words: *"tools that look cheap monthly
cost 3x more once you add seats"*, and *"pricing balloons when adding more users or
locations."*

**This is the opening.** A per-channel price punishes exactly the behaviour that makes the
product valuable. We already meter usage internally (Phase: usage metering, plan §70) and we
already treat a destination as free to add. Pricing on **published volume** rather than
channels or seats is both fairer and structurally impossible for an incumbent to copy
without cutting their own revenue.

### 2.3 What breaks in the competition

Drawn from review corpora, not marketing pages:

1. **Calendars collapse under volume.** "Unusable once you exceed 20–30 scheduled posts";
   "calendars fail to stay functional at 100+." A newsroom does 200 a day.
2. **Accounts disconnect mid-campaign.** Named repeatedly as the top operational failure.
3. **Approvals are messy.** The #1 complaint from agencies and multi-person teams.
4. **Reminder-only posting** — a tool that pings your phone instead of publishing — is
   called a dealbreaker in 2026, and is still common on Instagram and TikTok.
5. **Tool sprawl.** Creators run 4–6 tools; every switch is a chance to churn.

We are already correct on all five, and have never said so:

| Their failure | What we already built | Where |
| --- | --- | --- |
| Calendars collapse | Target-level independent state + lease-based execution | plan §12.2, §24 |
| Accounts disconnect | `gs-connection-health` refreshes ahead of expiry and escalates | ADR-007, docs/architecture/connection-health.md |
| Messy approvals | Approval control plane with deterministic policy | Phase 9 |
| Reminder-only | Native publish on all 13 adapters | packages/providers/* |
| Tool sprawl | Compose, media auto-fit, analytics, inbox, repurposing in one engine | Phases 3B–10 |

**The pivot is therefore two-thirds surfacing and one-third building.** The hardest parts
are done and unmarketed.

### 2.4 The newsroom segment

Echobox owns AI-driven newsroom social automation — pull from the CMS, reshare evergreen,
pick the time by model — and in 2026 drove The Daily Express and The Times to the top of the
UK social rankings. SocialFlow plays the same space, older and broader.

We already have the two hard pieces: **Content Intelligence** (source → draft, grounded,
with untrusted-source defense) and a **WordPress plugin** that shares an article in one call.
What is missing is the newsroom's actual daily object — a *feed of articles that publish
themselves under rules* — and the volume-shaped interface to supervise it.

This is the highest-revenue-per-account segment on the board and the one where our
architecture is furthest ahead.

### 2.5 The agent segment

MCP is now the default way an agent reaches a tool; ChatGPT, Claude, Cursor and Copilot all
speak it natively. Several competitors ship MCP servers. The differentiator is no longer
*having* one — it is what happens when the agent is wrong.

The pattern the market converged on in 2026 is **bounded autonomy**: not "do what you want
with my brand" but *"post up to 3× daily on LinkedIn, always in this voice, never about
these topics."*

That sentence is a description of our agent governance layer plus our social memory layer.
**No competitor has both.** Blotato has MCP and repurposing but no policy engine; the
governance vendors have no publishing engine. This is the single most defensible position
available to us, and it is already written.

---

## 3. Product principles for the creator surface

These extend plan §3. They govern the interface, not the engine.

- **C1. The first post happens in under five minutes, on the first visit.** Connect →
  write → publish, with nothing else required. No project, no environment, no API key.
- **C2. Nothing in the interface is named after a database table.** A creator has accounts,
  posts and a calendar. They do not have profiles, destinations, connections or targets.
  Those names stay in the API, where they are correct, and never appear in the studio.
- **C3. The default is assisted, not manual and not autonomous.** The system drafts; a
  human approves. Full autonomy is opt-in, per rule, with bounds.
- **C4. Automation must always show its reasoning and always be reversible.** Every
  automated action names the rule that caused it and offers a one-click undo before it goes
  out.
- **C5. Volume is a first-class case, not an edge case.** Every list, queue and calendar is
  designed at 500 items and merely *works* at 5.
- **C6. Mobile is a publishing surface, not a viewer.** A creator approves from a phone.
- **C7. The developer surface never regresses.** Every studio action is an API call that a
  customer could have made. No UI-only logic (plan P11/P15). The studio is proof the API is
  complete, and any studio feature that cannot be expressed as an API call is a bug in the
  API.
- **C8. An agent can do anything a human can do in the studio, under the same policy.**
  One authorization model, two front doors.

---

## 4. The four products, one engine

```
                    ┌──────────────────────────────────────────┐
                    │   Studio   Autopilot   Inbox   Insights  │   creator surface
                    ├──────────────────────────────────────────┤
                    │        REST API  ·  MCP  ·  SDK  ·  CLI  │   developer + agent surface
                    ├──────────────────────────────────────────┤
                    │  governance · memory · preflight · queue │   the engine (built)
                    │  13 adapters · reconciliation · health   │
                    └──────────────────────────────────────────┘
```

### 4.1 Creators & influencers — "never think about posting again"

The daily loop is: *what's going out today, what needs me, what worked.* Everything else is
configuration and belongs behind a settings door.

Needs, in priority order:

1. A **calendar and queue** that shows the week at a glance and takes a drag.
2. **Write once, see every network** — already built (`POST /v1/compose`), never surfaced
   as the primary way to create.
3. **Best-time posting** driven by their own performance data — we have the analytics store
   and the memory layer; the recommendation exists, the slot-picker does not.
4. **Repurposing**: one long thing becomes many short things.
5. **Inbox** so replies do not require opening five apps.
6. **Proof it worked** — insights in plain language, not a dashboard of charts.

### 4.2 Media houses & website owners — "the newsroom publishes itself"

The object is the **feed**, not the post. A newsroom connects a CMS or an RSS feed and sets
rules; the system does the rest and escalates exceptions.

Needs:

1. **Source → social, automatically**, with per-source rules (which networks, which voice,
   how many reshares, quiet hours).
2. **Evergreen resharing** — the single biggest traffic lever a publisher has, and the
   feature Echobox is bought for.
3. **Volume supervision** — 200 posts a day means the interface is an exception queue, not
   a calendar.
4. **Roles and approvals** — an editor approves, a social manager schedules, a journalist
   drafts.
5. **Traffic attribution** — which post drove which session. Website owners buy this, not
   engagement counts.
6. **Multi-brand** — a publisher runs many titles.

### 4.3 AI agents — "bounded autonomy"

Needs:

1. **MCP** — built.
2. **A policy engine that refuses correctly** — built (Phase 9).
3. **Memory the agent can read and write** — built (Phase 10), and unreachable from any UI,
   so a human cannot see what their agent believes.
4. **A human-visible audit of every agent action**, with the rule that permitted it.
5. **Agent-shaped errors** — built (plan §16), and genuinely better than the market.

The gap is not capability. It is that a human being cannot currently *watch* their agent.

### 4.4 Developers — "the best social API, unchanged"

No regressions. Everything they have today stays, moves to a `Developer` section of
settings, and gains: a Python SDK, the missing documentation pages, a status page and a
changelog.

---

## 5. The studio — information architecture

### 5.1 The change

| Today (developer-first) | Becomes (creator-first) |
| --- | --- |
| Overview | **Today** — what's going out, what needs you, what happened |
| Compose | **Studio** — compose + calendar + queue + media, one surface |
| Posts | folds into Studio (the queue and the archive) |
| Profiles | **Brands** — renamed, and demoted to settings for single-brand users |
| Connections | **Accounts** — the word every other tool uses |
| Media | folds into Studio |
| — | **Inbox** — comments and conversations *(API exists, no UI)* |
| — | **Insights** — analytics + what memory learned *(API exists, no UI)* |
| — | **Autopilot** — sources, rules, approvals, agent governance *(API exists, no UI)* |
| Webhooks, API keys, Logs, Playground, Platforms | **Settings → Developer** |
| — | **Settings → Usage** *(API exists, no UI)* |

The sidebar carries three bands — **Daily**, **Setup**, **Developer** — so the developer
surface stays whole (§4.4) without competing for attention with the work somebody came to do.

Four destinations reach the phone's bottom bar: **Today, Studio, Inbox, Autopilot**, plus
More. Insights is deliberately not among them. It is a screen somebody checks weekly with
intent, not one they tap between other things, and spending a thumb-reach slot on it would
cost the slot Autopilot needs — the screen where approvals land, which is the one thing a
creator genuinely does answer from a phone.

### 5.2 Today

The screen a creator opens every morning. Three bands:

1. **Needs you** — failed posts, expiring accounts, drafts awaiting approval, flagged
   replies. Empty state is the goal, not a failure.
2. **Going out** — the next 24 hours, editable in place.
3. **Landed** — what published since yesterday and how it did.

If all three are quiet, the screen says so in one line and offers the next best action. A
dashboard that shows twelve charts to someone with nothing to do has failed.

### 5.3 Studio

One surface, three views over the same queue: **Calendar** (week/month), **Queue** (list,
built for volume), **Grid** (visual, for Instagram/Pinterest planning).

The composer is `POST /v1/compose` as the *primary* creation path rather than an advanced
feature: write once, see every network render live, accept or adjust the per-network
adaptation, schedule or publish. The readiness line already returns plain language
("Nearly ready — a centred crop would lose 44% of the frame") — that becomes the main
feedback mechanism, not a preflight detail.

### 5.4 Autopilot

The automation control plane, in three levels that map onto the existing approval engine:

| Level | Behaviour | Existing mechanism |
| --- | --- | --- |
| **Manual** | You write, you publish | no policy |
| **Assisted** *(default)* | It drafts, you approve | approval control plane |
| **Autopilot** | It publishes within bounds | policy engine + memory + preflight |

A rule reads as a sentence: *"From **TechCrunch RSS**, post to **X and LinkedIn**, up to
**3× a day**, between **9am and 6pm**, in **the Acme voice**, never about **layoffs** —
**ask me first**."* That sentence is the entire UI, and each bolded span is a control.

This is the surface that makes the platform sticky for newsrooms and legible for agent
owners, and it is the single highest-value screen in this plan.

### 5.5 Inbox and Insights

**Inbox** — comments and conversations across networks, one thread list, reply inline.
Already served by `/v1/comments` and `/v1/conversations`.

**Insights** — plain-language findings first, charts second. "Your Tuesday 9am posts get
2.3× the reach of your Friday posts" is what the memory layer already computes; a line chart
of impressions is what every competitor shows instead. Lead with the finding.

---

## 6. Packaging and pricing

Design now, charge later (plan §70 — metering already records everything).

| Plan | For | Shape |
| --- | --- | --- |
| **Free** | Trying it | 3 accounts, 30 posts/mo, assisted mode |
| **Creator** | Individuals | **Unlimited accounts**, volume-metered, autopilot on |
| **Studio** | Small teams, agencies | + seats, approvals, multi-brand, white-label connect |
| **Newsroom** | Publishers, media | + unlimited sources, evergreen engine, traffic attribution, SLA |
| **Platform** | Developers embedding | usage-based API + MCP, white-label, no studio seat cost |

**Unlimited accounts and unlimited seats on every paid plan.** Meter published volume and
AI operations — the two things that actually cost us money — and nothing else. This directly
attacks the loudest complaint in the entire category and is the pricing page headline.

---

## 7. What gets built

Sequenced so each wave ships something usable on its own.

### Wave 1 — surface what exists  *(the dark features)*  — **shipped 2026-08-14**

The feature areas with working APIs and no interface. The largest value-per-effort on the
board, because the backend was already done and tested.

- [x] **Today** — `/app`, rebuilt as needs you / going out / landed
- [x] **Inbox** — `/app/inbox` *(read-only; see the gap below)*
- [x] **Insights** — `/app/insights`, findings in plain language before any number
- [x] **Autopilot** — `/app/autopilot`: approvals, feeds, the three levels, brand rules
- [x] **Usage** — `/app/usage`
- [x] IA restructure: Daily / Setup / Developer bands, four destinations on the phone bar
- [x] Creator vocabulary (C2): Overview→Today, Profiles→Brands, Connections→Accounts
- [x] First-run path rewritten: connect → write → let it run, no API key in step one

**Gap found while building.** The inbox can read comments and conversations but cannot
reply: no adapter implements a reply and no route exposes one. The screen says so plainly
rather than showing a compose box that would fail. Replying is a provider side effect and
needs the full Rule 6 treatment — attempt record, timeout, normalized errors, idempotency —
so it is Wave 2 work, not a text field.

### Wave 2 — the studio

- [ ] **Reply from the inbox** — adapter capability + route + attempt records (the gap above)
- [ ] Calendar and queue views over the existing post store
- [ ] Composer promoted to primary creation path, live per-network preview
- [ ] Drag-to-reschedule, bulk actions, volume-shaped list virtualization
- [ ] Best-time slot picker driven by the memory layer
- [ ] Onboarding: connect → write → publish in under five minutes (C1)

### Wave 3 — the newsroom engine

- [ ] Per-source automation rules (the sentence UI, §5.4)
- [ ] Evergreen resharing engine
- [ ] Traffic attribution (UTM issuance + click reconciliation)
- [ ] Roles and multi-brand
- [ ] Quiet hours, rate shaping, duplicate suppression across a title's feeds

### Wave 4 — completeness

- [x] **Outbound email** — Cloudflare Email Service, 2026-08-14. Was blocking *every*
      sign-up: the built-in Supabase mailer reached only Supabase project members at 2/hour,
      so no customer could ever receive a sign-in link. See `docs/OPERATIONS.md` §7.
- [x] **Model gateway adapter** — Claude, 2026-08-14. Unblocks every AI feature and makes
      the Autopilot screen a control plane for something that can actually run. The vendor
      SDK is confined to `@gs/model-anthropic` and `pnpm boundaries` now enforces that
      (plan §4.2), so swapping the model stays a one-package change. Needs an API key; see
      `docs/OPERATIONS.md` §5.
- [ ] Meta data-deletion callback (blocks Meta app review)
- [ ] Docs: the ~31 remaining pages from plan §99, status page, changelog
- [ ] Python SDK
- [ ] Marketing site rewritten for four audiences

### Non-goals for now

Explicitly not building, so effort does not leak (extends plan §72): influencer discovery
marketplaces, brand-deal management, paid-ads buying, a video editor, a link-in-bio product.
The first three are different businesses. A video editor is a company. Link-in-bio is a
plausible later addition but is not infrastructure and does not compound with the engine.

---

## 8. What does not change

Restated because a pivot is exactly when these get quietly broken:

- **P5 tenant isolation.** A studio screen resolves ownership server-side like everything
  else. Convenience is never a reason to trust a client-supplied ID.
- **P1 provider logic stays in `packages/providers/*`.** A calendar does not learn that
  Instagram needs a first comment.
- **Rule 10 no long-running work in the request path.** The studio calls the same 202 API.
- **P11/P15 the dashboard is an API client.** No UI-only publishing logic — and now the
  studio is the proof, since anything it can do, an agent can do (C7, C8).
- **Rule 9 never weaken an authorization check to make a test pass.**

---

## 9. How we know it worked

| Metric | Target | Why this one |
| --- | --- | --- |
| Time to first published post | < 5 min from signup | The only onboarding number that matters |
| Weekly active / signed up | > 40% | Proves daily-workflow status, not tool-drawer status |
| Posts per active account per week | > 12 | Habit, not experiment |
| Autopilot adoption | > 25% of paid | Proves the automation is trusted |
| Accounts disconnected > 24h | < 0.5% | The competition's top failure, as our top metric |
| Agent-published share | rising | Proves the agent bet |

---

## 10. Risks

**The studio dilutes the API.** Mitigated by C7 — every studio action is an API call. If a
screen needs an endpoint that does not exist, the endpoint gets built properly, with
contracts, scopes, ownership tests and docs (plan §85 Rule 5).

**Creator churn is brutal.** Free tiers churn at 60–80% in this category. Mitigated by
making autopilot the retention mechanism: a creator with a running automation does not
cancel, because cancelling is a decision to stop publishing.

**Newsrooms buy slowly.** Long procurement, reference-driven. Mitigated by the WordPress
plugin as a self-serve wedge into the long tail of website owners, and by shipping the
evergreen engine before chasing enterprise logos.

**AI cost per source is unbounded.** Mitigated by the extraction cache already in
`model-gateway.ts` and by metering AI operations as a priced unit from day one.

**No platform credentials yet.** The entire plan is publishable only on Bluesky, Telegram
and Discord until applications land. Mitigated by simulation mode, which lets the studio be
built, demoed and recorded end to end without a single approval — and the demo recording is
itself a gate on those approvals.

---

## 11. The one-sentence positioning

> **The social platform that publishes for you — whether "you" is a creator, a newsroom, or
> an AI agent.**

Creators hear *never think about posting again*. Newsrooms hear *your archive works while
you sleep*. Agent builders hear *autonomy with a policy engine behind it*. Developers hear
*the best social API, and now it has a face*.

---

## 12. Sources

Market research conducted 2026-08-14.

- Social media management market size — [Grand View Research](https://www.grandviewresearch.com/industry-analysis/social-media-management-market-report), [Business Research Insights](https://www.businessresearchinsights.com/market-reports/social-media-management-software-market-118049)
- Creator economy sizing — [Fungies creator economy statistics](https://fungies.io/creator-economy-statistics), [Presenc AI](https://presenc.ai/research/creator-economy-market-size-2026)
- Competitor pricing — [Buffer pricing analysis](https://www.blotato.com/blog/buffer-pricing), [Metricool review](https://www.creatorstackclub.com/software/metricool), [Buffer alternatives channel math](https://www.saasswitcher.com/blog/buffer-alternatives)
- Creator tool complaints — [Planable scheduling tools](https://planable.io/blog/schedule-social-media-posts/), [Adam Connell scheduler pros/cons](https://adamconnell.me/social-media-scheduler-tools/)
- Creator tool landscape — [Buffer best social media management tools](https://buffer.com/resources/best-social-media-management-tools/), [Sprinklr comparison](https://www.sprinklr.com/blog/social-media-management-tools/)
- AI repurposing — [Blotato AI content repurposing tools](https://www.blotato.com/blog/ai-content-repurposing-tools), [Blotato AI tools for creators](https://www.blotato.com/blog/ai-social-media-tools-for-creators)
- Newsroom automation — [Echobox review](https://research.com/software/reviews/echobox), [Echobox vs SocialFlow](https://www.cbinsights.com/compare/echobox-vs-socialflow)
- Agent/MCP patterns — [Postproxy MCP publishing](https://postproxy.dev/how-to/mcp-social-media-publishing/), [Blotato AI agents for social](https://www.blotato.com/blog/ai-agents-social-media), [Socialync agent guide](https://www.socialync.io/blog/run-your-social-media-with-an-ai-agent)
- WordPress distribution — [FS Poster plugin comparison](https://www.fs-poster.com/blog/best-wordpress-social-media-auto-posting-plugins), [Blog2Social](https://wordpress.org/plugins/blog2social/)
- Calendar/composer UX — [Planable social media calendar](https://planable.io/blog/social-media-calendar/), [Statusbrew calendar guide](https://statusbrew.com/insights/social-media-calendar)
