# ADR-007 — Application-layer envelope encryption for provider credentials

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** P9, §7

## Context

We hold OAuth access tokens, refresh tokens, app passwords and bot tokens for every connected social
account of every downstream customer of every organization. This is the highest-value data in the
system and the most damaging to leak.

These credentials are **high-cardinality application data**: created constantly, refreshed on a
schedule, rotated, revoked. That rules out putting each one in Cloudflare's account-level Secrets
Store, which is designed for a small set of operator secrets (plan §6.6).

Storing them as plaintext columns means every path that can read the database — a broad `SELECT`, a
backup, a support query, a logging mistake, a future analytics job — is a credential compromise.

## Decision

Store credentials as **application-layer encrypted ciphertext in Postgres**, in a dedicated
`social_credentials` table.

- **AES-256-GCM via Web Crypto**, available identically in Workers and in tests.
- **A root KEK outside Postgres**, in Cloudflare Secrets Store / Worker Secrets. A database dump
  alone is inert.
- **Key versioning from day one** (`key_version` column, `CREDENTIAL_KEK_V{n}` secrets). Rotation is
  a migration path that already exists rather than an emergency redesign.
- **Associated Authenticated Data** binds each ciphertext to
  `organization_id | project_id | connection_id | credential_type`. Moving a ciphertext row to
  another tenant makes it fail to decrypt — a confused-deputy attack becomes a crypto error.
- A random 12-byte nonce per encryption, stored alongside.

Decryption is confined to one module (`@gs/crypto`) and one call site per operation, immediately
before a provider call. Plaintext is never stored in a variable that outlives the call, never
returned by an API endpoint, and never written to a log.

**Never logged** (plan §7.2): access tokens, refresh tokens, auth codes, client secrets, raw
`Authorization` headers, full cookies, webhook secrets, private API keys. `@gs/observability` applies
redaction to provider request/response logs before persistence.

API keys are handled separately and are **not encrypted — they are hashed** (SHA-256 with a pepper).
We never need to recover an API key, only to verify one.

## Consequences

- A read-only database compromise does not yield working social credentials.
- Credential access is auditable at exactly one chokepoint.
- Key rotation is supported: write new credentials at version *n+1*, re-encrypt lazily on refresh,
  keep version *n* readable until drained.
- Cost: a crypto round trip per provider call, and the KEK becomes an availability dependency —
  losing it means every connection must be re-authorized. Backup and custody of KEK material are
  operational requirements, documented in the runbook.

## Alternatives considered

**Supabase Vault for everything.** Useful and may still hold selected backend secrets, but
frequently-refreshed per-user OAuth credentials need access control the application layer can
express and audit directly (plan §7.1).

**Postgres `pgcrypto` with a key in the database.** The key sits next to the data; a dump is a
compromise.

**Cloudflare Secrets Store per connection.** Explicitly rejected by plan §6.6 — wrong cardinality.
