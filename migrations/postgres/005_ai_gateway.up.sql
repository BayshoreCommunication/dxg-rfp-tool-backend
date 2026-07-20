ALTER TABLE rfpilot.ai_runs DROP CONSTRAINT ai_runs_status_check;
ALTER TABLE rfpilot.ai_runs
  ADD COLUMN operation text,
  ADD COLUMN purpose text,
  ADD COLUMN classification text,
  ADD COLUMN policy_id uuid,
  ADD COLUMN prompt_release_id uuid,
  ADD COLUMN schema_release_id uuid,
  ADD COLUMN idempotency_key text,
  ADD COLUMN input_checksum char(64) CHECK (input_checksum IS NULL OR input_checksum ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reserved_cost_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_cost_micros >= 0),
  ADD COLUMN latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ADD COLUMN finish_reason text,
  ADD COLUMN output jsonb;
ALTER TABLE rfpilot.ai_runs ADD CONSTRAINT ai_runs_status_check
  CHECK (status IN ('policy_checking','budget_reserved','started','validating','succeeded','rejected','failed','cancelled'));
CREATE UNIQUE INDEX ai_runs_idempotency_idx ON rfpilot.ai_runs(organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE rfpilot.ai_provider_policies (
  id uuid PRIMARY KEY, organization_id uuid REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL, operation text NOT NULL, purpose text NOT NULL, classification text NOT NULL,
  provider text NOT NULL, model text NOT NULL, region text NOT NULL, retention_mode text NOT NULL,
  max_attempts smallint NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 2),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK(timeout_ms BETWEEN 1 AND 30000),
  active boolean NOT NULL DEFAULT false, approved_at timestamptz, effective_from timestamptz NOT NULL,
  effective_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(provider='mock'), CHECK(classification='synthetic'), CHECK(environment='test')
);
CREATE TABLE rfpilot.prompt_releases (
  id uuid PRIMARY KEY, stable_key text NOT NULL, version text NOT NULL, operation text NOT NULL,
  purpose text NOT NULL, content text NOT NULL, content_checksum char(64) NOT NULL CHECK(content_checksum ~ '^[0-9a-f]{64}$'),
  variables jsonb NOT NULL DEFAULT '[]', max_input_bytes integer NOT NULL, max_output_bytes integer NOT NULL,
  approved_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(stable_key,version)
);
CREATE TABLE rfpilot.output_schema_releases (
  id uuid PRIMARY KEY, stable_key text NOT NULL, version text NOT NULL, schema_document jsonb NOT NULL,
  schema_checksum char(64) NOT NULL CHECK(schema_checksum ~ '^[0-9a-f]{64}$'), approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(stable_key,version)
);
ALTER TABLE rfpilot.ai_runs ADD CONSTRAINT ai_runs_policy_fk FOREIGN KEY(policy_id) REFERENCES rfpilot.ai_provider_policies(id) ON DELETE RESTRICT;
ALTER TABLE rfpilot.ai_runs ADD CONSTRAINT ai_runs_prompt_fk FOREIGN KEY(prompt_release_id) REFERENCES rfpilot.prompt_releases(id) ON DELETE RESTRICT;
ALTER TABLE rfpilot.ai_runs ADD CONSTRAINT ai_runs_schema_fk FOREIGN KEY(schema_release_id) REFERENCES rfpilot.output_schema_releases(id) ON DELETE RESTRICT;

CREATE TABLE rfpilot.ai_run_attempts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.ai_runs(id) ON DELETE RESTRICT, attempt_number smallint NOT NULL,
  provider text NOT NULL, model text NOT NULL, status text NOT NULL CHECK(status IN('started','succeeded','failed')),
  safe_code text, input_tokens integer CHECK(input_tokens>=0), output_tokens integer CHECK(output_tokens>=0),
  cost_micros bigint CHECK(cost_micros>=0), latency_ms integer CHECK(latency_ms>=0), started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, UNIQUE(run_id,attempt_number)
);
CREATE TABLE rfpilot.ai_validation_results (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.ai_runs(id) ON DELETE RESTRICT, validator text NOT NULL, validator_version text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN('passed','failed')), safe_codes jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rfpilot.ai_budget_accounts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL, period_type text NOT NULL CHECK(period_type IN('daily','monthly')), period_start date NOT NULL,
  limit_micros bigint NOT NULL CHECK(limit_micros>=0), reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
  consumed_micros bigint NOT NULL DEFAULT 0 CHECK(consumed_micros>=0), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,environment,period_type,period_start)
);
CREATE TABLE rfpilot.ai_budget_ledger (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.ai_runs(id) ON DELETE RESTRICT, entry_type text NOT NULL CHECK(entry_type IN('reserve','consume','release')),
  amount_micros bigint NOT NULL CHECK(amount_micros>=0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rfpilot.ai_test_requests (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id ~ '^[0-9a-f]{24}$'),
  operation text NOT NULL CHECK(operation IN('extractStructured','classify','summarize','generateFromEvidence')),
  fixture text NOT NULL CHECK(fixture IN('basic','invalid_output','prompt_injection')),
  evidence_references jsonb NOT NULL DEFAULT '[]', idempotency_key text NOT NULL, correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,idempotency_key)
);
ALTER TABLE rfpilot.ai_provider_policies ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_provider_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_run_attempts ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_run_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_validation_results ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_validation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_budget_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_budget_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_budget_ledger ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_budget_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_test_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.ai_test_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_policies ON rfpilot.ai_provider_policies USING(organization_id IS NULL OR organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id IS NULL OR organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_ai_attempts ON rfpilot.ai_run_attempts USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_ai_validations ON rfpilot.ai_validation_results USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_ai_budgets ON rfpilot.ai_budget_accounts USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_ai_ledger ON rfpilot.ai_budget_ledger USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_ai_test_requests ON rfpilot.ai_test_requests USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE FUNCTION rfpilot.reject_ai_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ai_budget_ledger is append-only'; END $$;
CREATE TRIGGER ai_budget_ledger_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.ai_budget_ledger FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_ai_ledger_mutation();

INSERT INTO rfpilot.ai_provider_policies(id,environment,operation,purpose,classification,provider,model,region,retention_mode,active,approved_at,effective_from)
VALUES
('10000000-0000-7000-8000-000000000001','test','extractStructured','contract_test','synthetic','mock','deterministic-v1','local','none',true,now(),now()),
('10000000-0000-7000-8000-000000000002','test','classify','contract_test','synthetic','mock','deterministic-v1','local','none',true,now(),now()),
('10000000-0000-7000-8000-000000000003','test','summarize','contract_test','synthetic','mock','deterministic-v1','local','none',true,now(),now()),
('10000000-0000-7000-8000-000000000004','test','generateFromEvidence','contract_test','synthetic','mock','deterministic-v1','local','none',true,now(),now());
INSERT INTO rfpilot.prompt_releases(id,stable_key,version,operation,purpose,content,content_checksum,variables,max_input_bytes,max_output_bytes,approved_at)
VALUES('20000000-0000-7000-8000-000000000001','mock-contract-test','1.0.0','*','contract_test','Deterministic synthetic contract test only.','4115318ce58ebc8f693c028daeeb444c16bac44c21d76bdbaf1cbe61d100d378','["fixture"]',16384,16384,now());
INSERT INTO rfpilot.output_schema_releases(id,stable_key,version,schema_document,schema_checksum,approved_at)
VALUES('30000000-0000-7000-8000-000000000001','mock-contract-result','1.0.0','{"type":"object","additionalProperties":false,"required":["operation","result","citations"],"properties":{"operation":{"type":"string"},"result":{"type":"string","maxLength":4096},"citations":{"type":"array","maxItems":20,"items":{"type":"string","maxLength":200}}}}','1523383fb1d3746ae69366e35e4345dd4760008f2491bfe3b2049943399af7f8',now());
