-- =============================================================================
-- Row Level Security  (plan §5.3, ADR-003)
--
-- Defence in depth, not the only defence. Backend Workers connect as
-- `gs_app`, a dedicated least-privilege role that BYPASSES RLS, and they still
-- perform explicit ownership checks in application code (plan P5). RLS exists
-- to constrain the *browser-facing* path: anything the dashboard reaches
-- through Supabase's anon/authenticated roles.
--
-- The rule these policies encode: a human may only see rows belonging to an
-- organization they are a member of.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Membership helper
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER so the function can read organization_members regardless of
-- the caller's own policies, which is what stops the membership lookup from
-- recursing into the policies that call it.
--
-- STABLE lets the planner call it once per statement rather than once per row —
-- the difference between an index scan and a sequential scan on large tables.
CREATE OR REPLACE FUNCTION public.gs_member_organization_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT organization_id
  FROM public.organization_members
  WHERE user_id = auth.uid()
    AND accepted_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.gs_member_organization_ids() FROM public;
GRANT EXECUTE ON FUNCTION public.gs_member_organization_ids() TO authenticated;

-- Role check for write paths. Viewers and analysts must not mutate.
CREATE OR REPLACE FUNCTION public.gs_has_org_role(
  target_org uuid,
  allowed_roles organization_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = target_org
      AND user_id = auth.uid()
      AND accepted_at IS NOT NULL
      AND role = ANY(allowed_roles)
  );
$$;

REVOKE ALL ON FUNCTION public.gs_has_org_role(uuid, organization_role[]) FROM public;
GRANT EXECUTE ON FUNCTION public.gs_has_org_role(uuid, organization_role[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS
--
-- FORCE applies policies even to the table owner, so a mistake in role setup
-- cannot silently disable every policy at once.
-- -----------------------------------------------------------------------------

ALTER TABLE public.organizations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_environments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_key_scopes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_connections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_destinations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_credentials        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_scopes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_health_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oauth_sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connect_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_apps             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_variants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_targets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_target_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_approvals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_subscriptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_webhook_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_request_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_request_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters            ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Credentials are NEVER readable from the browser.
--
-- No policy is created for social_credentials, and RLS is enabled — so every
-- browser-side SELECT returns zero rows. Provider tokens are reachable only
-- through the application role, which decrypts them in @gs/crypto immediately
-- before a provider call (ADR-007).
-- -----------------------------------------------------------------------------

-- Same reasoning for provider_apps: it holds encrypted client secrets.

-- -----------------------------------------------------------------------------
-- Organization-scoped read policies
-- -----------------------------------------------------------------------------

CREATE POLICY org_read ON public.organizations
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.gs_member_organization_ids()));

CREATE POLICY org_update ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.gs_has_org_role(id, ARRAY['owner','admin']::organization_role[]))
  WITH CHECK (public.gs_has_org_role(id, ARRAY['owner','admin']::organization_role[]));

CREATE POLICY members_read ON public.organization_members
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.gs_member_organization_ids()));

CREATE POLICY members_manage ON public.organization_members
  FOR ALL TO authenticated
  USING (public.gs_has_org_role(organization_id, ARRAY['owner','admin']::organization_role[]))
  WITH CHECK (public.gs_has_org_role(organization_id, ARRAY['owner','admin']::organization_role[]));

-- Every table below carries `organization_id` precisely so this policy is one
-- indexed predicate rather than a join chain evaluated per row.
DO $$
DECLARE
  t text;
  -- Only tables that actually carry `organization_id`. Tables reached solely
  -- through a parent get an explicit join-based policy further down.
  read_only_tables text[] := ARRAY[
    'outbound_webhook_events', 'provider_request_logs', 'api_request_logs',
    'audit_events', 'usage_events', 'usage_counters', 'idempotency_keys'
  ];
  writable_tables text[] := ARRAY[
    'projects', 'project_environments', 'profiles', 'api_keys',
    'social_connections', 'social_destinations', 'media_assets',
    'posts', 'post_targets', 'webhook_endpoints'
  ];
BEGIN
  FOREACH t IN ARRAY read_only_tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (organization_id IN (SELECT public.gs_member_organization_ids()))',
      t || '_read', t
    );
  END LOOP;

  FOREACH t IN ARRAY writable_tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (organization_id IN (SELECT public.gs_member_organization_ids()))',
      t || '_read', t
    );
    -- Writes additionally require a role that is allowed to change things.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
         USING (public.gs_has_org_role(organization_id,
                  ARRAY[''owner'',''admin'',''developer'',''marketer'']::organization_role[]))
         WITH CHECK (public.gs_has_org_role(organization_id,
                  ARRAY[''owner'',''admin'',''developer'',''marketer'']::organization_role[]))',
      t || '_write', t
    );
  END LOOP;
END $$;

-- Tables reached only through a parent. Scoped by joining upward once.
--
-- These deliberately do NOT carry a denormalized organization_id: they are never
-- read on the publishing hot path, only through their parent, so the extra
-- column would be write amplification with no read benefit.

CREATE POLICY post_target_attempts_read ON public.post_target_attempts
  FOR SELECT TO authenticated
  USING (
    post_id IN (
      SELECT id FROM public.posts
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY post_approvals_read ON public.post_approvals
  FOR SELECT TO authenticated
  USING (
    post_id IN (
      SELECT id FROM public.posts
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY post_approvals_write ON public.post_approvals
  FOR ALL TO authenticated
  USING (
    post_id IN (
      SELECT p.id FROM public.posts p
      WHERE public.gs_has_org_role(p.organization_id,
              ARRAY['owner','admin','developer','marketer']::organization_role[])
    )
  )
  WITH CHECK (
    post_id IN (
      SELECT p.id FROM public.posts p
      WHERE public.gs_has_org_role(p.organization_id,
              ARRAY['owner','admin','developer','marketer']::organization_role[])
    )
  );

CREATE POLICY connection_health_events_read ON public.connection_health_events
  FOR SELECT TO authenticated
  USING (
    connection_id IN (
      SELECT id FROM public.social_connections
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY webhook_deliveries_read ON public.webhook_deliveries
  FOR SELECT TO authenticated
  USING (
    webhook_endpoint_id IN (
      SELECT id FROM public.webhook_endpoints
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY api_key_scopes_read ON public.api_key_scopes
  FOR SELECT TO authenticated
  USING (
    api_key_id IN (
      SELECT id FROM public.api_keys
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY connection_scopes_read ON public.connection_scopes
  FOR SELECT TO authenticated
  USING (
    connection_id IN (
      SELECT id FROM public.social_connections
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY media_variants_read ON public.media_variants
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.gs_member_organization_ids()));

CREATE POLICY webhook_subscriptions_read ON public.webhook_subscriptions
  FOR SELECT TO authenticated
  USING (
    webhook_endpoint_id IN (
      SELECT id FROM public.webhook_endpoints
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY oauth_sessions_read ON public.oauth_sessions
  FOR SELECT TO authenticated
  USING (
    profile_id IN (
      SELECT id FROM public.profiles
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

CREATE POLICY connect_sessions_read ON public.connect_sessions
  FOR SELECT TO authenticated
  USING (
    profile_id IN (
      SELECT id FROM public.profiles
      WHERE organization_id IN (SELECT public.gs_member_organization_ids())
    )
  );

-- provider_events has no organization_id at ingest time (we do not yet know
-- whose webhook it is) and carries raw provider payloads. Browser access is
-- denied outright; the dashboard reads the processed result, not the raw event.

-- -----------------------------------------------------------------------------
-- Indexes supporting the policy predicates
--
-- Without these, every policy check is a sequential scan and the dashboard
-- becomes unusable at scale.
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS posts_org_idx                    ON public.posts (organization_id);
CREATE INDEX IF NOT EXISTS post_targets_org_idx             ON public.post_targets (organization_id);
CREATE INDEX IF NOT EXISTS media_assets_org_idx             ON public.media_assets (organization_id);
CREATE INDEX IF NOT EXISTS profiles_org_idx                 ON public.profiles (organization_id);
CREATE INDEX IF NOT EXISTS social_connections_org_idx       ON public.social_connections (organization_id);
CREATE INDEX IF NOT EXISTS social_destinations_org_idx      ON public.social_destinations (organization_id);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx        ON public.webhook_endpoints (organization_id);
CREATE INDEX IF NOT EXISTS outbound_webhook_events_org_idx  ON public.outbound_webhook_events (organization_id);
CREATE INDEX IF NOT EXISTS api_keys_org_idx                 ON public.api_keys (organization_id);
