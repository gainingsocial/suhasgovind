# Architecture Decision Records

Each ADR records one architecturally significant decision, the forces behind it, and its
consequences. ADRs are **append-only**: to change a decision, write a new ADR that supersedes the
old one and update the old one's status.

Per plan §85 Rule 1, read the relevant ADR before modifying architecture.

| ADR                                       | Title                                    | Status   |
| ----------------------------------------- | ---------------------------------------- | -------- |
| [001](ADR-001-typescript.md)              | TypeScript end to end                    | Accepted |
| [002](ADR-002-separate-api-worker.md)     | Public API Worker separate from Next.js  | Accepted |
| [003](ADR-003-supabase-hyperdrive.md)     | Supabase Postgres reached via Hyperdrive | Accepted |
| [004](ADR-004-provider-adapters.md)       | Provider adapter architecture            | Accepted |
| [005](ADR-005-workflows-and-queues.md)    | Cloudflare Workflows + Queues            | Accepted |
| [006](ADR-006-effective-once.md)          | Effective-once publishing                | Accepted |
| [007](ADR-007-token-encryption.md)        | Application-layer token encryption       | Accepted |
| [008](ADR-008-unified-plus-native.md)     | Unified core + provider-native options   | Accepted |

## Template

```markdown
# ADR-NNN — Title

**Status:** Proposed | Accepted | Superseded by ADR-XXX
**Date:** YYYY-MM-DD

## Context

## Decision

## Consequences

## Alternatives considered
```
