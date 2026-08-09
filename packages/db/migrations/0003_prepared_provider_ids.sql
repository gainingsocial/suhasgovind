-- Persist the provider-side ids created during preparation (ADR-006 Layer 4).
--
-- `PreparedPublish.providerMediaIds` has always been documented as existing "for
-- reconciliation and cleanup", but nothing stored it, so it survived only as long as the
-- worker invocation that produced it. That made it useless for exactly the case it was
-- designed for: reconciliation runs in a *different* invocation, after the one that
-- created those ids has already failed.
--
-- Why this matters more than it looks. Instagram and Threads publish in two steps — create
-- a media container, then publish that container by id. The container is a real object
-- whose status Meta maintains, so asking "is container X published?" is a definitive
-- answer to "did this post go out?".
--
-- Without the container id, reconciliation falls back to listing recent posts and matching
-- on caption text. That cannot distinguish this post from an identical one the customer
-- published deliberately an hour ago, and it cannot say anything at all about a post with
-- no caption. With the id, the same question has a provable answer, and the difference
-- between provable and inferred is the difference between adopting the post and escalating
-- to a human.
--
-- Nullable and additive: existing rows have no prepared ids, and adapters that prepare
-- nothing (Bluesky, Telegram, a plain Facebook text post) continue to write nothing here.

ALTER TABLE post_targets
  ADD COLUMN prepared_provider_ids jsonb;

COMMENT ON COLUMN post_targets.prepared_provider_ids IS
  'Provider-side ids created during prepare() — media containers, unpublished photos, upload sessions. Read by reconciliation to ask the provider directly whether a publish landed, rather than inferring it from recent post text. Not secret: these are opaque object ids, never credentials.';
