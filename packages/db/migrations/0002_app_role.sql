-- =============================================================================
-- Application database role  (plan §5.3, ADR-003)
--
-- Workers connect as `gs_app`, never as `postgres` and never with the Supabase
-- service_role key. The role is created here so the grant surface is versioned
-- and reviewable; the password is NOT set here, because a migration is
-- committed to git and a password must never be (P9).
--
-- Provisioning sets the password out of band:
--     ALTER ROLE gs_app WITH LOGIN PASSWORD '<generated>';
--
-- Until that runs the role cannot log in, so applying this migration on its own
-- opens no access.
--
-- BYPASSRLS is deliberate. RLS constrains the browser-facing path through
-- Supabase's anon/authenticated roles (see 0001). The backend enforces tenant
-- isolation explicitly in application code (plan P5) and needs to read across
-- organizations to run queues, reconciliation and webhook delivery.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gs_app') THEN
    -- NOLOGIN until a password is provisioned. NOINHERIT so membership in any
    -- future group role has to be assumed deliberately via SET ROLE.
    CREATE ROLE gs_app WITH NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Schema access
--
-- `public` only. The role is given nothing in `auth`, `storage` or `vault` —
-- the API has no business reading Supabase's own tables.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO gs_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gs_app;

-- Tables added by later migrations must be reachable without another grant
-- being remembered. These apply to objects created by `postgres`, which is the
-- role the migration runner uses.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gs_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gs_app;

-- -----------------------------------------------------------------------------
-- Explicitly withheld
--
-- No DDL. A compromised application credential must not be able to drop a
-- table, disable a policy, or rewrite a migration ledger entry.
-- -----------------------------------------------------------------------------

REVOKE CREATE ON SCHEMA public FROM gs_app;

-- The migration ledger is written by the migration runner as `postgres`.
-- The application never touches it.
REVOKE ALL ON SCHEMA drizzle FROM gs_app;
