-- Room Specification Recommendations (room-recommendation.v1).
--
-- A recommendation run is a deterministic, immutable snapshot: confirmed
-- proposal facts + approved knowledge fixtures -> classified, review-gated
-- suggestions. The payload is persisted verbatim so review and application
-- always reference exactly what was generated, never a recomputation.
-- Recommendations NEVER write to the proposal at generation time; application
-- is a separate explicit endpoint restricted to a tiny allowlisted set of
-- room fields, guarded by proposal-version CAS and per-room identity checks.
--
-- input_checksum makes generation idempotent: an unchanged proposal returns
-- the stored run instead of inserting a duplicate.
CREATE TABLE rfpilot.room_recommendation_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  proposal_version integer NOT NULL CHECK (proposal_version >= 1),
  schema_version text NOT NULL DEFAULT 'room-recommendation.v1',
  engine_version text NOT NULL DEFAULT 'room-rules.v1',
  input_checksum char(64) NOT NULL CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  room_count integer NOT NULL DEFAULT 0 CHECK (room_count >= 0),
  recommendation_count integer NOT NULL DEFAULT 0 CHECK (recommendation_count >= 0),
  question_count integer NOT NULL DEFAULT 0 CHECK (question_count >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  blocking_count integer NOT NULL DEFAULT 0 CHECK (blocking_count >= 0),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_reference_id, input_checksum)
);
ALTER TABLE rfpilot.room_recommendation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.room_recommendation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_room_recommendation_runs ON rfpilot.room_recommendation_runs
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE INDEX room_recommendation_runs_latest_idx ON rfpilot.room_recommendation_runs (proposal_reference_id, created_at DESC);

-- One review per run per reviewer, versioned by revision for optimistic
-- concurrency (mirrors candidate_review_sets).
CREATE TABLE rfpilot.room_recommendation_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.room_recommendation_runs(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, actor_external_user_id)
);
ALTER TABLE rfpilot.room_recommendation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.room_recommendation_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_room_recommendation_reviews ON rfpilot.room_recommendation_reviews
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

-- Per-recommendation decisions are also the governed producer-feedback
-- record: the suggested value, the final value, an enumerated reason code
-- (the first such vocabulary in the schema), the classification and rule /
-- knowledge provenance are all snapshotted here so outcomes can be evaluated
-- later without re-reading run payloads. Not used for any automated training.
CREATE TABLE rfpilot.room_recommendation_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL REFERENCES rfpilot.room_recommendation_reviews(id) ON DELETE RESTRICT,
  recommendation_key text NOT NULL CHECK (char_length(recommendation_key) BETWEEN 3 AND 200),
  decision text NOT NULL CHECK (decision IN ('pending','accepted','edited','rejected')),
  suggested_value jsonb NOT NULL,
  decided_value jsonb,
  classification text NOT NULL CHECK (classification IN ('confirmed_fact','deterministic_derivation','recommended_assumption','unknown')),
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rule_ids jsonb NOT NULL DEFAULT '[]',
  knowledge_ids jsonb NOT NULL DEFAULT '[]',
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('correct','excessive','insufficient','unsupported_assumption','wrong_room_type','client_constraint','venue_constraint','budget_constraint','schedule_constraint','other')),
  note varchar(500),
  engine_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, recommendation_key),
  CHECK ((decision = 'edited') = (decided_value IS NOT NULL))
);
ALTER TABLE rfpilot.room_recommendation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.room_recommendation_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_room_recommendation_decisions ON rfpilot.room_recommendation_decisions
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

-- Application audit: which reviewed recommendations were explicitly written
-- into the proposal, at which expected/resulting version, or why they were
-- refused. status='conflict' rows are kept — a refused application is
-- evidence, not garbage.
CREATE TABLE rfpilot.room_recommendation_applications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.room_recommendation_runs(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL REFERENCES rfpilot.room_recommendation_reviews(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  status text NOT NULL CHECK (status IN ('applied','conflict')),
  expected_proposal_version integer NOT NULL CHECK (expected_proposal_version >= 1),
  resulting_proposal_version integer CHECK (resulting_proposal_version >= 1),
  selected_count integer NOT NULL CHECK (selected_count BETWEEN 1 AND 50),
  applied_paths jsonb NOT NULL DEFAULT '[]',
  safe_error_code text,
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
ALTER TABLE rfpilot.room_recommendation_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.room_recommendation_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_room_recommendation_applications ON rfpilot.room_recommendation_applications
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE INDEX room_recommendation_applications_run_idx ON rfpilot.room_recommendation_applications (run_id, created_at DESC);

-- Deliberately no immutability triggers (migration 029 precedent): every
-- trigger added before the retention sweep had to be walked back in 027.
