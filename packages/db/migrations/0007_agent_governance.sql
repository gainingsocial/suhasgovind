-- Agent governance and the approval control plane (plan §51, Phase 9).
--
-- The premise: an agent acting on a customer's social accounts is not a script holding a
-- key, it is an actor whose authority must be describable, auditable and revocable
-- independently of whichever credential it happens to be using today.
--
-- Identity is separate from the API key deliberately. A key gets rotated; an identity has
-- to outlive that, or "what has this agent done over six months" becomes unanswerable and
-- revoking its authority turns into a hunt for every key it ever held.
--
-- Policies are rows, not branches. The rules customers actually want are specific to them
-- — "Instagram Reels need sign-off", "may auto-publish to LinkedIn", "never delete" — and
-- encoding those in code would mean a deploy per customer.
--
-- Actions are recorded whether they were allowed, held or refused. Storing only the
-- permitted ones would erase the evidence of an agent repeatedly attempting something it
-- should not, which is exactly the signal worth keeping.
--
-- Nothing here changes existing behaviour: an environment with no agent identities and no
-- policies is unaffected, and human and API-key callers never touch these tables.

CREATE TABLE agent_identities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  operator text,
  disabled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_identities_org_idx ON agent_identities (organization_id);
CREATE UNIQUE INDEX agent_identities_org_name_key ON agent_identities (organization_id, name);

COMMENT ON TABLE agent_identities IS
  'A named non-human actor, separate from the API key it authenticates with so its history survives key rotation (plan §51).';

CREATE TABLE agent_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  project_environment_id uuid REFERENCES project_environments (id) ON DELETE CASCADE,
  agent_identity_id uuid REFERENCES agent_identities (id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  effect text NOT NULL,
  actions text[] NOT NULL DEFAULT '{}'::text[],
  providers text[] NOT NULL DEFAULT '{}'::text[],
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_approver_role text NOT NULL DEFAULT 'admin',
  reason_code text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Constrained in the database rather than trusted from the application. An unrecognized
  -- effect would fall through the evaluator's switch, and a policy row that matches but
  -- decides nothing is indistinguishable from no policy at all — which silently downgrades
  -- a `deny` to the default.
  CONSTRAINT agent_policies_effect_check
    CHECK (effect IN ('allow', 'require_approval', 'deny'))
);

CREATE INDEX agent_policies_org_priority_idx ON agent_policies (organization_id, priority DESC);
CREATE INDEX agent_policies_agent_idx ON agent_policies (agent_identity_id);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running',
  objective text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_identity_started_idx ON agent_runs (agent_identity_id, started_at DESC);
CREATE INDEX agent_runs_environment_idx ON agent_runs (project_environment_id);

CREATE TABLE agent_actions (
  id uuid PRIMARY KEY,
  agent_run_id uuid REFERENCES agent_runs (id) ON DELETE CASCADE,
  agent_identity_id uuid NOT NULL REFERENCES agent_identities (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  action text NOT NULL,
  provider text,
  resource_type text,
  resource_id uuid,
  decision text NOT NULL,
  policy_id uuid REFERENCES agent_policies (id) ON DELETE SET NULL,
  reason_code text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_actions_decision_check
    CHECK (decision IN ('allowed', 'requires_approval', 'denied'))
);

CREATE INDEX agent_actions_identity_created_idx ON agent_actions (agent_identity_id, created_at DESC);
CREATE INDEX agent_actions_resource_idx ON agent_actions (resource_type, resource_id);

-- "What has been refused lately" is the query an operator actually runs, and it is a small
-- fraction of the rows. Partial, so the index stays small even when an agent is busy.
CREATE INDEX agent_actions_decision_idx
  ON agent_actions (organization_id, created_at DESC)
  WHERE decision <> 'allowed';

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
  agent_identity_id uuid REFERENCES agent_identities (id) ON DELETE SET NULL,
  agent_action_id uuid REFERENCES agent_actions (id) ON DELETE SET NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason_code text,
  required_approver_role text NOT NULL DEFAULT 'admin',
  summary text,
  decided_by_user_id uuid,
  decided_at timestamptz,
  decision_note text,

  -- NOT NULL on purpose. A request that waits forever is a post that silently never goes
  -- out, which is the worst failure this product has — so an unanswered request expires
  -- visibly rather than sitting in a queue nobody reads.
  expires_at timestamptz NOT NULL,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT approval_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'))
);

CREATE INDEX approval_requests_pending_idx
  ON approval_requests (project_environment_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX approval_requests_expiry_idx
  ON approval_requests (expires_at)
  WHERE status = 'pending';

-- One live request per subject. Two pending approvals for the same post would let one
-- approver accept while another rejects, with nothing deciding which wins.
CREATE UNIQUE INDEX approval_requests_subject_key
  ON approval_requests (subject_type, subject_id)
  WHERE status = 'pending';

COMMENT ON COLUMN approval_requests.expires_at IS
  'Mandatory. An approval that never expires becomes a post that silently never publishes.';
