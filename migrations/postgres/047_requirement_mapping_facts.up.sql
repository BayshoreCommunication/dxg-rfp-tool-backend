ALTER TABLE rfpilot.ai_provider_attempts
  DROP CONSTRAINT ai_provider_attempts_run_type_check;
ALTER TABLE rfpilot.ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_run_type_check
  CHECK (run_type IN (
    'proposal_context','proposal_draft','conversation_chat','vendor_response_analyze',
    'platform_assistant','vendor_requirement_facts'
  ));

CREATE UNIQUE INDEX evidence_fragments_org_id_uq
  ON rfpilot.evidence_fragments(organization_id,id);

CREATE TABLE rfpilot.vendor_intelligence_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL,
  requirement_set_id uuid NOT NULL,
  vendor_submission_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_submission_version_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  job_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  input_checksum char(64) NOT NULL CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  requirement_mapping_version text NOT NULL DEFAULT 'requirement-mapping.v1',
  fact_schema_version text NOT NULL DEFAULT 'vendor-fact.v1',
  validation_version text NOT NULL DEFAULT 'mapping-fact-validation.v1',
  prompt_version text NOT NULL DEFAULT 'vendor-intelligence-prompt.v1',
  provider text,
  model text,
  requirement_count integer NOT NULL DEFAULT 0 CHECK (requirement_count >= 0),
  mapped_requirement_count integer NOT NULL DEFAULT 0 CHECK (mapped_requirement_count >= 0),
  fact_count integer NOT NULL DEFAULT 0 CHECK (fact_count >= 0),
  contradiction_count integer NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings)='array'),
  safe_error_code text,
  output_checksum char(64) CHECK (output_checksum IS NULL OR output_checksum ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,proposal_reference_id)
    REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_set_id,organization_id)
    REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,job_id)
    REFERENCES rfpilot.ai_jobs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.requirement_evidence_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  intelligence_run_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  evidence_fragment_id uuid,
  relationship text NOT NULL CHECK (relationship IN ('supports','partially_supports','contradicts','context_only','none')),
  confidence numeric(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  mapping_method text NOT NULL DEFAULT 'model' CHECK (mapping_method IN ('model','deterministic_none')),
  mapping_version text NOT NULL,
  ambiguity_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ambiguity_reasons)='array'),
  validation_state text NOT NULL DEFAULT 'valid' CHECK (validation_state IN ('valid','rejected')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intelligence_run_id,requirement_id,evidence_fragment_id,relationship),
  FOREIGN KEY (organization_id,intelligence_run_id)
    REFERENCES rfpilot.vendor_intelligence_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_id,organization_id)
    REFERENCES rfpilot.requirements(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evidence_fragment_id)
    REFERENCES rfpilot.evidence_fragments(organization_id,id) ON DELETE RESTRICT,
  CHECK (
    (relationship='none' AND evidence_fragment_id IS NULL) OR
    (relationship<>'none' AND evidence_fragment_id IS NOT NULL)
  )
);

CREATE TABLE rfpilot.extracted_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  intelligence_run_id uuid NOT NULL,
  vendor_submission_version_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  fact_key text NOT NULL CHECK (fact_key ~ '^[a-z][a-z0-9_.:-]{0,149}$'),
  family text NOT NULL CHECK (family IN (
    'company_profile','experience','references','staffing','equipment','schedule_logistics',
    'hybrid_streaming_recording','accessibility','sustainability_dei','insurance_policy',
    'commercial','assumption_exception_dependency','alternative'
  )),
  fact_type text NOT NULL CHECK (fact_type ~ '^[a-z][a-z0-9_]{0,79}$'),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 1200),
  value_kind text NOT NULL CHECK (value_kind IN ('string','number','boolean','money','date','date_range','duration','quantity','list','unknown')),
  typed_value jsonb NOT NULL CHECK (jsonb_typeof(typed_value)='object'),
  normalized_value text NOT NULL DEFAULT '' CHECK (char_length(normalized_value) <= 2000),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 80),
  currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  period_start date,
  period_end date,
  explicitness text NOT NULL CHECK (explicitness IN ('explicit','derived')),
  confidence numeric(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  validation_state text NOT NULL DEFAULT 'valid' CHECK (validation_state IN ('valid','rejected')),
  contradiction_group text CHECK (contradiction_group IS NULL OR contradiction_group ~ '^contradiction:[0-9a-f]{16}$'),
  extraction_version text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (intelligence_run_id,ordinal),
  FOREIGN KEY (organization_id,intelligence_run_id)
    REFERENCES rfpilot.vendor_intelligence_runs(organization_id,id) ON DELETE RESTRICT,
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE TABLE rfpilot.extracted_fact_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  fact_id uuid NOT NULL,
  evidence_fragment_id uuid NOT NULL,
  support_role text NOT NULL CHECK (support_role IN ('supports','contradicts','context')),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fact_id,evidence_fragment_id,support_role),
  FOREIGN KEY (organization_id,fact_id)
    REFERENCES rfpilot.extracted_facts(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evidence_fragment_id)
    REFERENCES rfpilot.evidence_fragments(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.fact_validation_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  fact_id uuid NOT NULL,
  check_type text NOT NULL CHECK (check_type IN ('schema','citation','typed_value','contradiction','prohibited_language')),
  outcome text NOT NULL CHECK (outcome IN ('passed','warning','rejected')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fact_id,check_type,reason_code),
  FOREIGN KEY (organization_id,fact_id)
    REFERENCES rfpilot.extracted_facts(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.human_review_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  intelligence_run_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('fact','mapping')),
  target_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected','corrected','escalated')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  corrected_payload jsonb CHECK (corrected_payload IS NULL OR jsonb_typeof(corrected_payload)='object'),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,intelligence_run_id)
    REFERENCES rfpilot.vendor_intelligence_runs(organization_id,id) ON DELETE RESTRICT,
  CHECK ((decision='corrected' AND corrected_payload IS NOT NULL) OR (decision<>'corrected' AND corrected_payload IS NULL))
);

CREATE INDEX vendor_intelligence_version_idx ON rfpilot.vendor_intelligence_runs
  (organization_id,vendor_submission_version_mongo_id,created_at DESC);
CREATE INDEX mapping_run_requirement_idx ON rfpilot.requirement_evidence_mappings
  (intelligence_run_id,requirement_id,ordinal);
CREATE INDEX mapping_fragment_idx ON rfpilot.requirement_evidence_mappings(evidence_fragment_id)
  WHERE evidence_fragment_id IS NOT NULL;
CREATE UNIQUE INDEX mapping_none_once_idx ON rfpilot.requirement_evidence_mappings(intelligence_run_id,requirement_id)
  WHERE relationship='none';
CREATE INDEX facts_run_family_idx ON rfpilot.extracted_facts(intelligence_run_id,family,ordinal);
CREATE INDEX facts_contradiction_idx ON rfpilot.extracted_facts(intelligence_run_id,contradiction_group)
  WHERE contradiction_group IS NOT NULL;
CREATE INDEX fact_evidence_fragment_idx ON rfpilot.extracted_fact_evidence(evidence_fragment_id);
CREATE INDEX human_review_target_idx ON rfpilot.human_review_events(intelligence_run_id,target_type,target_id,created_at DESC);

ALTER TABLE rfpilot.vendor_intelligence_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.vendor_intelligence_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirement_evidence_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirement_evidence_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.extracted_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.extracted_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.extracted_fact_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.extracted_fact_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.fact_validation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.fact_validation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.human_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.human_review_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_vendor_intelligence_runs ON rfpilot.vendor_intelligence_runs USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_requirement_evidence_mappings ON rfpilot.requirement_evidence_mappings USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_extracted_facts ON rfpilot.extracted_facts USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_extracted_fact_evidence ON rfpilot.extracted_fact_evidence USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_fact_validation_results ON rfpilot.fact_validation_results USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_human_review_events ON rfpilot.human_review_events USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.guard_vendor_intelligence_output_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vendor intelligence output is immutable';
END $$;
CREATE TRIGGER requirement_evidence_mappings_immutable BEFORE UPDATE ON rfpilot.requirement_evidence_mappings FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_vendor_intelligence_output_update();
CREATE TRIGGER extracted_facts_immutable BEFORE UPDATE ON rfpilot.extracted_facts FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_vendor_intelligence_output_update();
CREATE TRIGGER extracted_fact_evidence_immutable BEFORE UPDATE ON rfpilot.extracted_fact_evidence FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_vendor_intelligence_output_update();
CREATE TRIGGER fact_validation_results_immutable BEFORE UPDATE ON rfpilot.fact_validation_results FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_vendor_intelligence_output_update();
CREATE TRIGGER human_review_events_immutable BEFORE UPDATE ON rfpilot.human_review_events FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_vendor_intelligence_output_update();
