-- Analytics and external post normalization (plan Phase 6).
--
-- Two rules shape this schema.
--
-- **Never query a provider live for a dashboard load.** Plan Phase 6 says so outright, and
-- the reason is arithmetic: a customer with forty connected accounts opening an overview
-- page would fire forty provider calls, exhaust a rate limit publishing also depends on,
-- and take twelve seconds to render a number that was good enough an hour ago.
--
-- **Never imply analytics is real-time when it is not.** Three timestamps, deliberately
-- distinct: when we asked, what the provider said the numbers were current as of, and when
-- we will ask again. Collapsing them is how a customer concludes their post got no
-- engagement when in truth nobody has looked yet.
--
-- external_posts covers posts we did not publish. A brand's account has history, and an
-- overview that silently omits everything posted before they signed up — or from the
-- platform's own app since — is a chart that misleads by construction. post_target_id is
-- NULL for those, and that is a normal permanent state rather than a gap to backfill.
--
-- Snapshots are append-only rather than a mutable row of current values. Engagement is a
-- curve, not a number: "did the reel keep gaining views after day two" is the question that
-- decides what to post next, and overwriting yesterday's figure makes it unanswerable.

CREATE TABLE external_posts (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES social_destinations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_post_id text NOT NULL,
  external_url text,
  post_target_id uuid REFERENCES post_targets (id) ON DELETE SET NULL,
  post_id uuid REFERENCES posts (id) ON DELETE SET NULL,
  post_type text,
  excerpt text,
  published_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  deleted_detected_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Discovery is at-least-once: a sync re-reads a window overlapping the last one. Without
-- this, a weekly sync accumulates a duplicate of every post it saw twice and every
-- engagement number is double-counted.
CREATE UNIQUE INDEX external_posts_destination_external_key
  ON external_posts (destination_id, external_post_id);

CREATE INDEX external_posts_profile_published_idx ON external_posts (profile_id, published_at DESC);
CREATE INDEX external_posts_environment_idx ON external_posts (project_environment_id);
CREATE INDEX external_posts_target_idx ON external_posts (post_target_id)
  WHERE post_target_id IS NOT NULL;

COMMENT ON COLUMN external_posts.post_target_id IS
  'Set when this system published it. NULL means it was posted another way — a normal permanent state, not a gap to fill.';

CREATE TABLE analytics_snapshots (
  id uuid PRIMARY KEY,
  external_post_id uuid NOT NULL REFERENCES external_posts (id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES social_destinations (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  provider text NOT NULL,

  observed_at timestamptz NOT NULL DEFAULT now(),
  provider_data_as_of timestamptz,
  next_expected_refresh timestamptz,

  -- bigint, not integer. A viral post outgrows an int32, and discovering that in production
  -- means silently wrong numbers rather than an error.
  impressions bigint,
  reach bigint,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  clicks bigint,
  engagements bigint,
  watch_time_seconds bigint,
  followers_delta bigint,

  -- Everything the provider returned with no normalized home. A normalized model that
  -- drops what it does not recognize quietly loses the metric a customer's strategy
  -- depends on. Namespaced by provider so two platforms' `plays` cannot collide.
  native_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_snapshots_post_observed_idx
  ON analytics_snapshots (external_post_id, observed_at DESC);
CREATE INDEX analytics_snapshots_environment_observed_idx
  ON analytics_snapshots (project_environment_id, observed_at DESC);
CREATE INDEX analytics_snapshots_due_idx
  ON analytics_snapshots (next_expected_refresh)
  WHERE next_expected_refresh IS NOT NULL;

COMMENT ON COLUMN analytics_snapshots.provider_data_as_of IS
  'What the provider said the numbers were current as of — on most platforms hours behind observed_at. Distinct on purpose (plan Phase 6).';
