CREATE TABLE rfpilot.vendor_evaluation_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL,
  requirement_set_id uuid NOT NULL,
  matrix_version_id uuid NOT NULL,
  intelligence_run_id uuid NOT NULL,
  vendor_submission_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_submission_version_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','archived')),
  sealed_price boolean NOT NULL DEFAULT false,
  assessment_version text NOT NULL DEFAULT 'vendor-assessment.v1',
  risk_policy_version text NOT NULL DEFAULT 'evaluation-risk.v1',
  commercial_policy_version text NOT NULL DEFAULT 'commercial-normalization.v1',
  scoring_policy_version text NOT NULL DEFAULT 'confirmed-rubric-score.v1',
  requirement_checksum char(64) NOT NULL CHECK (requirement_checksum ~ '^[0-9a-f]{64}$'),
  intelligence_checksum char(64) NOT NULL CHECK (intelligence_checksum ~ '^[0-9a-f]{64}$'),
  output_checksum char(64) NOT NULL CHECK (output_checksum ~ '^[0-9a-f]{64}$'),
  assessment_count integer NOT NULL DEFAULT 0 CHECK (assessment_count >= 0),
  risk_count integer NOT NULL DEFAULT 0 CHECK (risk_count >= 0),
  question_count integer NOT NULL DEFAULT 0 CHECK (question_count >= 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  created_by_external_user_id varchar(24) NOT NULL CHECK (created_by_external_user_id ~ '^[0-9a-f]{24}$'),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (intelligence_run_id),
  FOREIGN KEY (organization_id,proposal_reference_id) REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_set_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (matrix_version_id,organization_id) REFERENCES rfpilot.evaluation_matrix_versions(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,intelligence_run_id) REFERENCES rfpilot.vendor_intelligence_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.ai_assessments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('addressed','partially_addressed','missing','contradictory','not_applicable','not_assessable')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1600),
  confidence numeric(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  needs_human_review boolean NOT NULL,
  review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_reasons)='array'),
  assessment_method text NOT NULL DEFAULT 'deterministic_mapping' CHECK (assessment_method='deterministic_mapping'),
  assessment_version text NOT NULL,
  supersedes_assessment_id uuid,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (evaluation_run_id,requirement_id),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_id,organization_id) REFERENCES rfpilot.requirements(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,supersedes_assessment_id) REFERENCES rfpilot.ai_assessments(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.assessment_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  evidence_fragment_id uuid NOT NULL,
  support_role text NOT NULL CHECK (support_role IN ('supports','contradicts','context')),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id,evidence_fragment_id,support_role),
  FOREIGN KEY (organization_id,assessment_id) REFERENCES rfpilot.ai_assessments(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evidence_fragment_id) REFERENCES rfpilot.evidence_fragments(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.assessment_validation_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  check_type text NOT NULL CHECK (check_type IN ('citation','verdict','mandatory','coverage','contradiction')),
  outcome text NOT NULL CHECK (outcome IN ('passed','warning','rejected')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id,check_type,reason_code),
  FOREIGN KEY (organization_id,assessment_id) REFERENCES rfpilot.ai_assessments(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evaluation_risks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  requirement_id uuid,
  fact_id uuid,
  category text NOT NULL CHECK (category IN ('mandatory_gap','contradiction','commercial_exception','commercial_non_comparable','missing_detail','reference_unverified')),
  severity text NOT NULL CHECK (severity IN ('high','medium','low')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  basis text NOT NULL CHECK (char_length(basis) BETWEEN 1 AND 1600),
  disposition text NOT NULL DEFAULT 'needs_review' CHECK (disposition='needs_review'),
  policy_version text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (evaluation_run_id,ordinal),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_id,organization_id) REFERENCES rfpilot.requirements(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,fact_id) REFERENCES rfpilot.extracted_facts(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.risk_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  risk_id uuid NOT NULL,
  evidence_fragment_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (risk_id,evidence_fragment_id),
  FOREIGN KEY (organization_id,risk_id) REFERENCES rfpilot.evaluation_risks(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evidence_fragment_id) REFERENCES rfpilot.evidence_fragments(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.clarification_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  risk_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'candidate' CHECK (status='candidate'),
  generator_version text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evaluation_run_id,ordinal),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,risk_id) REFERENCES rfpilot.evaluation_risks(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.commercial_submissions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL UNIQUE,
  submitted_total numeric(18,2),
  submitted_currency char(3) CHECK (submitted_currency IS NULL OR submitted_currency ~ '^[A-Z]{3}$'),
  basis text NOT NULL DEFAULT 'vendor_stated' CHECK (basis='vendor_stated'),
  total_fact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,total_fact_id) REFERENCES rfpilot.extracted_facts(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.commercial_line_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  commercial_submission_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  category text NOT NULL,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1200),
  amount numeric(18,2),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  option_or_exclusion boolean NOT NULL DEFAULT false,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commercial_submission_id,fact_id),
  FOREIGN KEY (organization_id,commercial_submission_id) REFERENCES rfpilot.commercial_submissions(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,fact_id) REFERENCES rfpilot.extracted_facts(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.commercial_normalizations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  commercial_submission_id uuid NOT NULL UNIQUE,
  comparable boolean NOT NULL,
  normalized_total numeric(18,2),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  arithmetic_status text NOT NULL CHECK (arithmetic_status IN ('verified_identity','refused')),
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions)='array'),
  refusal_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(refusal_codes)='array'),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,commercial_submission_id) REFERENCES rfpilot.commercial_submissions(organization_id,id) ON DELETE RESTRICT,
  CHECK ((comparable AND normalized_total IS NOT NULL AND arithmetic_status='verified_identity') OR (NOT comparable AND normalized_total IS NULL AND arithmetic_status='refused'))
);

CREATE TABLE rfpilot.evaluation_assignments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  evaluator_external_user_id varchar(24) NOT NULL CHECK (evaluator_external_user_id ~ '^[0-9a-f]{24}$'),
  role text NOT NULL CHECK (role IN ('technical','commercial','combined','observer')),
  conflict_status text NOT NULL DEFAULT 'pending' CHECK (conflict_status IN ('pending','clear','conflict')),
  conflict_note text NOT NULL DEFAULT '' CHECK (char_length(conflict_note) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','reopened')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  assigned_by_external_user_id varchar(24) NOT NULL CHECK (assigned_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,evaluation_run_id,id),
  UNIQUE (evaluation_run_id,evaluator_external_user_id),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evaluation_assignment_criteria (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL,
  criterion_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id,criterion_id),
  FOREIGN KEY (organization_id,assignment_id) REFERENCES rfpilot.evaluation_assignments(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (criterion_id,organization_id) REFERENCES rfpilot.evaluation_criteria(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.commercial_access_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('granted','revoked')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evaluation_run_id,assignment_id) REFERENCES rfpilot.evaluation_assignments(organization_id,evaluation_run_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evaluator_score_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evaluation_run_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  criterion_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('draft','submitted','reopened','superseded')),
  score numeric(8,3),
  rubric_maximum numeric(8,3) NOT NULL CHECK (rubric_maximum > 0),
  criterion_weight numeric(7,3) NOT NULL CHECK (criterion_weight BETWEEN 0 AND 100),
  weighted_contribution numeric(9,4),
  rationale text NOT NULL DEFAULT '' CHECK (char_length(rationale) <= 3000),
  evidence_fragment_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_fragment_ids)='array'),
  supersedes_event_id uuid,
  scoring_policy_version text NOT NULL,
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evaluation_run_id,assignment_id) REFERENCES rfpilot.evaluation_assignments(organization_id,evaluation_run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (criterion_id,organization_id) REFERENCES rfpilot.evaluation_criteria(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,supersedes_event_id) REFERENCES rfpilot.evaluator_score_events(organization_id,id) ON DELETE RESTRICT,
  CHECK ((event_type IN ('draft','submitted','superseded') AND score IS NOT NULL AND weighted_contribution IS NOT NULL) OR (event_type='reopened' AND score IS NULL AND weighted_contribution IS NULL)),
  CHECK (score IS NULL OR (score >= 0 AND score <= rubric_maximum))
);

CREATE INDEX assessments_run_idx ON rfpilot.ai_assessments(evaluation_run_id,ordinal);
CREATE INDEX assessment_evidence_fragment_idx ON rfpilot.assessment_evidence(evidence_fragment_id);
CREATE INDEX risks_run_idx ON rfpilot.evaluation_risks(evaluation_run_id,severity,ordinal);
CREATE INDEX commercial_lines_submission_idx ON rfpilot.commercial_line_items(commercial_submission_id,ordinal);
CREATE INDEX assignments_evaluator_idx ON rfpilot.evaluation_assignments(organization_id,evaluator_external_user_id,status);
CREATE INDEX score_events_assignment_idx ON rfpilot.evaluator_score_events(assignment_id,criterion_id,created_at DESC);
CREATE INDEX commercial_access_assignment_idx ON rfpilot.commercial_access_events(assignment_id,created_at DESC);

ALTER TABLE rfpilot.vendor_evaluation_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.vendor_evaluation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_assessments ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assessment_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.assessment_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assessment_validation_results ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.assessment_validation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_risks ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.evaluation_risks FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.risk_evidence ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.risk_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.clarification_candidates ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.clarification_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.commercial_submissions ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.commercial_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.commercial_line_items ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.commercial_line_items FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.commercial_normalizations ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.commercial_normalizations FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_assignments ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.evaluation_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_assignment_criteria ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.evaluation_assignment_criteria FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.commercial_access_events ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.commercial_access_events FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluator_score_events ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.evaluator_score_events FORCE ROW LEVEL SECURITY;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['vendor_evaluation_runs','ai_assessments','assessment_evidence','assessment_validation_results','evaluation_risks','risk_evidence','clarification_candidates','commercial_submissions','commercial_line_items','commercial_normalizations','evaluation_assignments','evaluation_assignment_criteria','commercial_access_events','evaluator_score_events'] LOOP
    EXECUTE format('CREATE POLICY tenant_%I ON rfpilot.%I USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id())',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION rfpilot.guard_evaluation_derived_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'evaluation derived output is immutable'; END $$;
CREATE TRIGGER vendor_evaluation_runs_immutable BEFORE UPDATE OR DELETE ON rfpilot.vendor_evaluation_runs FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER ai_assessments_immutable BEFORE UPDATE OR DELETE ON rfpilot.ai_assessments FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER assessment_evidence_immutable BEFORE UPDATE OR DELETE ON rfpilot.assessment_evidence FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER assessment_validation_results_immutable BEFORE UPDATE OR DELETE ON rfpilot.assessment_validation_results FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER evaluation_risks_immutable BEFORE UPDATE OR DELETE ON rfpilot.evaluation_risks FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER risk_evidence_immutable BEFORE UPDATE OR DELETE ON rfpilot.risk_evidence FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER clarification_candidates_immutable BEFORE UPDATE OR DELETE ON rfpilot.clarification_candidates FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER commercial_submissions_immutable BEFORE UPDATE OR DELETE ON rfpilot.commercial_submissions FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER commercial_line_items_immutable BEFORE UPDATE OR DELETE ON rfpilot.commercial_line_items FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER commercial_normalizations_immutable BEFORE UPDATE OR DELETE ON rfpilot.commercial_normalizations FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER evaluation_assignment_criteria_immutable BEFORE UPDATE OR DELETE ON rfpilot.evaluation_assignment_criteria FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER commercial_access_events_immutable BEFORE UPDATE OR DELETE ON rfpilot.commercial_access_events FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
CREATE TRIGGER evaluator_score_events_immutable BEFORE UPDATE OR DELETE ON rfpilot.evaluator_score_events FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_evaluation_derived_update();
