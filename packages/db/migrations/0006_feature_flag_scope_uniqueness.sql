-- Make the feature-flag scope constraint actually constrain anything (plan §45).
--
-- `feature_flags_scope_key` covers (key, organization_id, project_id,
-- project_environment_id). Three of those four are NULL for a global flag, two for an
-- organization-scoped one — and Postgres treats NULLs as distinct in a unique index by
-- default. The constraint therefore did not apply to the scopes that use it most: every
-- upsert of a global flag inserted another row instead of updating the existing one.
--
-- The consequence is not a duplicate row nobody notices. `resolveFlags` picks a winner by
-- scope specificity, and among several rows at the *same* specificity the winner is
-- whichever the scan returned last. A provider kill switch flipped off and then back on
-- would leave two contradictory global rows, and the provider would read as enabled or
-- disabled depending on physical row order. A kill switch that sometimes reads as off is
-- worse than no kill switch, because it will be trusted during an incident.
--
-- This is the same NULL-distinct trap that `social_credentials` documents in migration
-- 0004. That one was solved with partial indexes because it had exactly two rules to
-- state; here there are four scope shapes and only one rule, so NULLS NOT DISTINCT says
-- it directly. Requires PG15+; this database runs 17.
--
-- Any duplicates created before this ran must go first, keeping the most recently updated
-- row — which is the one whoever last touched the flag intended.

DELETE FROM feature_flags a
  USING feature_flags b
  WHERE a.key = b.key
    AND a.organization_id IS NOT DISTINCT FROM b.organization_id
    AND a.project_id IS NOT DISTINCT FROM b.project_id
    AND a.project_environment_id IS NOT DISTINCT FROM b.project_environment_id
    AND (a.updated_at, a.id) < (b.updated_at, b.id);

DROP INDEX IF EXISTS feature_flags_scope_key;

CREATE UNIQUE INDEX feature_flags_scope_key
  ON feature_flags (key, organization_id, project_id, project_environment_id)
  NULLS NOT DISTINCT;
