-- Workstream 1: structured AV production pricing corpus with provenance.
CREATE TABLE rfpilot.pricing_records(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 category text NOT NULL CHECK(category IN('audio','video','lighting','staging','led_wall','projection','breakout_room','general_session','labor','rigging','power','trucking_freight','travel_per_diem','venue_fee','insurance','service_charge_tax','other')),
 item_label text NOT NULL CHECK(char_length(item_label) BETWEEN 1 AND 200),
 unit text NOT NULL CHECK(unit IN('per_day','per_event','per_hour','per_person','per_room','flat')),
 amount_low_minor bigint NOT NULL CHECK(amount_low_minor>=0),
 amount_mid_minor bigint NOT NULL,
 amount_high_minor bigint NOT NULL,
 currency char(3) NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 market text CHECK(market IS NULL OR char_length(market)<=100),
 day_type text NOT NULL DEFAULT 'any' CHECK(day_type IN('standard','overtime','holiday','any')),
 labor_role text CHECK(labor_role IS NULL OR char_length(labor_role)<=100),
 source_fragment_id uuid REFERENCES rfpilot.knowledge_source_fragments(id),
 source_note text NOT NULL DEFAULT '' CHECK(char_length(source_note)<=500),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','retired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id~'^[0-9a-f]{24}$'),
 approved_by_external_user_id varchar(24) CHECK(approved_by_external_user_id IS NULL OR approved_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(amount_low_minor<=amount_mid_minor AND amount_mid_minor<=amount_high_minor)
);
CREATE INDEX pricing_records_lookup_idx ON rfpilot.pricing_records(organization_id,status,category);

-- Workstream 1: human-editable expert rules (declarative conditions/effects).
CREATE TABLE rfpilot.expert_rules(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 rule_key text NOT NULL CHECK(rule_key~'^[a-z0-9_-]{3,80}$'),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
 explanation text NOT NULL DEFAULT '' CHECK(char_length(explanation)<=1000),
 conditions jsonb NOT NULL DEFAULT '[]',
 effect jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','retired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 updated_by_external_user_id varchar(24) NOT NULL CHECK(updated_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,rule_key)
);
CREATE INDEX expert_rules_active_idx ON rfpilot.expert_rules(organization_id,status);

-- Workstream 3: investment guidance reports with provenance and refusals.
CREATE TABLE rfpilot.investment_guidance_reports(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id~'^[0-9a-f]{24}$'),
 proposal_version integer NOT NULL CHECK(proposal_version>=1),
 engine_version text NOT NULL DEFAULT 'investment-rules.v1',
 currency char(3),
 total_low_minor bigint,
 total_mid_minor bigint,
 total_high_minor bigint,
 line_items jsonb NOT NULL DEFAULT '[]',
 refusals jsonb NOT NULL DEFAULT '[]',
 ancillary jsonb NOT NULL DEFAULT '[]',
 recommendations jsonb NOT NULL DEFAULT '[]',
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investment_guidance_latest_idx ON rfpilot.investment_guidance_reports(proposal_reference_id,created_at DESC);

-- Workstream 4: vendor-proposal analysis runs and findings.
CREATE TABLE rfpilot.vendor_analysis_runs(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 vendor_response_mongo_id varchar(24) NOT NULL CHECK(vendor_response_mongo_id~'^[0-9a-f]{24}$'),
 job_id uuid NOT NULL UNIQUE REFERENCES rfpilot.ai_jobs(id),
 actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id~'^[0-9a-f]{24}$'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','succeeded','failed','conflict')),
 provider text NOT NULL DEFAULT 'openai' CHECK(provider IN('mock','openai')),
 model text NOT NULL,
 requirement_count integer NOT NULL DEFAULT 0 CHECK(requirement_count>=0),
 finding_count integer NOT NULL DEFAULT 0 CHECK(finding_count>=0),
 escalation_count integer NOT NULL DEFAULT 0 CHECK(escalation_count>=0),
 input_tokens integer,
 output_tokens integer,
 provider_request_id text,
 safe_error_code text,
 idempotency_key text NOT NULL,
 correlation_id uuid NOT NULL,
 retention_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(organization_id,idempotency_key)
);
CREATE INDEX vendor_analysis_runs_response_idx ON rfpilot.vendor_analysis_runs(organization_id,vendor_response_mongo_id,created_at DESC);

CREATE TABLE rfpilot.vendor_analysis_findings(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 run_id uuid NOT NULL REFERENCES rfpilot.vendor_analysis_runs(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 199),
 kind text NOT NULL CHECK(kind IN('compliance','pricing_flag','production_flag','vendor_question')),
 requirement_path text CHECK(requirement_path IS NULL OR requirement_path~'^/content/'),
 requirement_label text NOT NULL DEFAULT '' CHECK(char_length(requirement_label)<=300),
 verdict text CHECK(verdict IS NULL OR verdict IN('addressed','partial','missing','not_applicable')),
 message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 2000),
 confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 needs_human_review boolean NOT NULL DEFAULT false,
 citations jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,ordinal)
);

ALTER TABLE rfpilot.pricing_records ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.pricing_records FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.expert_rules ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.expert_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.investment_guidance_reports ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.investment_guidance_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.vendor_analysis_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.vendor_analysis_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.vendor_analysis_findings ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.vendor_analysis_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_pricing_records ON rfpilot.pricing_records USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_expert_rules ON rfpilot.expert_rules USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_investment_guidance_reports ON rfpilot.investment_guidance_reports USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_vendor_analysis_runs ON rfpilot.vendor_analysis_runs USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_vendor_analysis_findings ON rfpilot.vendor_analysis_findings USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
