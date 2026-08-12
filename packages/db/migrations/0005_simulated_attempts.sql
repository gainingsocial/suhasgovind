-- Simulation mode reaches the attempt record (plan §49).
--
-- `project_environments.simulation_mode` has existed since the initial schema and nothing
-- read it. Now the publisher does: in a simulating environment the whole pipeline runs —
-- lease, ownership, connection health, content and override resolution, media resolution
-- and signing — and the provider call is the only step that does not happen.
--
-- The target still ends `published` and the customer webhook still fires. That identity is
-- the point: a test mode whose state machine differs from production forces every customer
-- to write a branch in order to test themselves, which is precisely what a test mode
-- exists to avoid.
--
-- So the honesty has to live somewhere other than the state. This column is that place —
-- the single field that distinguishes "we published this" from "we would have". A
-- distinct attempt outcome was the alternative and was rejected: `attempt_outcome` is
-- switched on throughout the engine, and adding a value would make every one of those
-- switches wrong by omission.
--
-- Defaults false, so every existing attempt is correctly recorded as real. NOT NULL,
-- because "we do not know whether this reached the provider" is not an answer this system
-- may give.

ALTER TABLE post_target_attempts
  ADD COLUMN simulated boolean NOT NULL DEFAULT false;

-- Denormalized onto the target as well, so reading a post does not have to join its
-- attempts to answer "was this real?". The alternative was inferring it from the `sim_`
-- prefix on provider_post_id, and a fact this important should not be recovered by parsing
-- a string. It also stays correct after an environment is switched back to live, which a
-- lookup of the environment's current mode would not.
ALTER TABLE post_targets
  ADD COLUMN simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN post_targets.simulated IS
  'True when this target reached published without any provider being contacted (plan §49).';

COMMENT ON COLUMN post_target_attempts.simulated IS
  'True when no provider was contacted (plan §49). The state machine of a simulated publish is deliberately identical to a real one; this is the field that keeps the record honest about which attempts actually left the building.';

-- Simulated publishes are excluded from provider success/failure rates and from usage
-- billing, and both of those questions are asked over a time range. Partial, because the
-- overwhelming majority of rows are real and indexing them would be dead weight.
CREATE INDEX post_target_attempts_simulated_idx
  ON post_target_attempts (post_id)
  WHERE simulated = true;
