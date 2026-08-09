# Working in this repository

## The specification

`UNIFIED_SOCIAL_API_MASTER_BUILD_PLAN.md` (5,958 lines) is the authoritative product and
architecture specification. When this file and the plan disagree, **the plan wins**.

Read `docs/adr/` before changing architecture (plan §85 Rule 1).

## Hard rules

Violating any of these is a bug, not a style disagreement.

1. **Never invent provider API behaviour.** Consult the official, current provider documentation
   before implementing or changing an adapter (plan §85 Rule 2). Cite the doc URL in the adapter's
   header comment.
2. **No provider-specific logic outside `packages/providers/*`** (plan P1). The core resolves
   adapters via the `@gs/providers` registry. `pnpm boundaries` enforces this.
3. **Tenant ownership is verified server-side on every operation** (plan P5). Resolve
   `destination → connection → profile → environment → project` and check it against the
   authenticated key's scope. Every route needs an ownership test.
4. **Provider credentials are encrypted and never logged** (plan P9, §7.2). Decrypt only in
   `@gs/crypto`, only immediately before a provider call.
5. **Queues and webhooks are at-least-once** (plan P4). Every consumer must be safe to run twice.
   The target lease in `@gs/db` is the mechanism — do not bypass it.
6. **No long-running work in the request path** (plan §85 Rule 10). `POST /v1/posts` returns 202.
7. **Every DB change gets a migration** (Rule 8). Never edit an applied migration.
8. **Never weaken RLS or an authorization check to make a test pass** (Rule 9).
9. **All public timestamps are UTC ISO-8601** (Rule 15).
10. **When uncertain about platform behaviour, fail safely with a useful error** rather than guessing
    (Rule 14).

## Every new public route needs (plan §85 Rule 5)

- Zod input **and** output schema in `@gs/contracts`
- OpenAPI registration
- an auth scope
- a tenant-ownership test
- documented error codes
- request ID propagation

## Every provider side effect needs (Rule 6)

- idempotency awareness
- an attempt record
- a timeout
- normalized errors
- observability

## Before declaring a task complete (plan §86)

```
[ ] compiles       [ ] lint      [ ] unit tests    [ ] ownership tests
[ ] OpenAPI        [ ] docs      [ ] migration     [ ] no secrets in logs
[ ] error codes documented       [ ] webhook impact considered
[ ] capability/preflight impact considered
```

## Conventions

- Package names are `@gs/<name>`. Provider packages are `@gs/provider-<name>`.
- Public resource IDs are prefixed and opaque: `org_ prj_ env_ pro_ con_ dst_ med_ pst_ ptg_ wh_
  evt_ key_`. Internally they are UUIDv7 (sortable). Never expose sequential IDs.
- Error codes are `SCREAMING_SNAKE_CASE`, stable, and documented in `docs/errors/`.
- Repositories express domain operations (`leaseTargetForExecution`), not CRUD (plan §76).

## Running things

```bash
pnpm run ci                # what CI runs: lint, typecheck, test, boundaries, openapi, build
                           # `run` is required — pnpm reserves the bare `ci` command
pnpm --filter @gs/api run deploy   # deploy the API Worker
                           # `run` is required here too — pnpm reserves bare `deploy`
pnpm test -- <pattern>     # focused tests
pnpm boundaries            # architectural layering check
```
