CREATE TABLE rfpilot.requirement_sets(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0),
 proposal_version text NOT NULL,
 proposal_checksum char(64) NOT NULL CHECK(proposal_checksum~'^[0-9a-f]{64}$'),
 rendered_rfp_run_id uuid REFERENCES rfpilot.proposal_draft_runs(id) ON DELETE RESTRICT,
 rendered_rfp_checksum char(64) CHECK(rendered_rfp_checksum IS NULL OR rendered_rfp_checksum~'^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','in_review','approved','superseded')),
 generator_version text NOT NULL DEFAULT 'requirement-registry.v1',
 lock_version integer NOT NULL DEFAULT 1 CHECK(lock_version>0),
 validation jsonb NOT NULL DEFAULT '{"blocking":[],"warnings":[]}'::jsonb,
 content_checksum char(64) NOT NULL CHECK(content_checksum~'^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
 created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id~'^[0-9a-f]{24}$'),
 approved_by_external_user_id varchar(24) CHECK(approved_by_external_user_id IS NULL OR approved_by_external_user_id~'^[0-9a-f]{24}$'),
 approved_at timestamptz,
 superseded_by_id uuid,
 superseded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id),
 UNIQUE(organization_id,proposal_reference_id,version),
 FOREIGN KEY(superseded_by_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(organization_id,idempotency_key)
);

CREATE TABLE rfpilot.evaluation_matrix_versions(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 requirement_set_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','superseded')),
 weights_confirmed boolean NOT NULL DEFAULT false,
 total_weight numeric(7,3) NOT NULL DEFAULT 0 CHECK(total_weight BETWEEN 0 AND 700),
 content_checksum char(64) NOT NULL CHECK(content_checksum~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 approved_at timestamptz,
 UNIQUE(id,organization_id),
 UNIQUE(requirement_set_id),
 UNIQUE(organization_id,proposal_reference_id,version),
 FOREIGN KEY(requirement_set_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evaluation_criteria(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 matrix_version_id uuid NOT NULL,
 criterion_key text NOT NULL CHECK(criterion_key~'^[a-z][a-z0-9_]{0,79}$'),
 name text NOT NULL CHECK(char_length(trim(name)) BETWEEN 1 AND 200),
 description text NOT NULL DEFAULT '' CHECK(char_length(description)<=2000),
 weight numeric(7,3) NOT NULL CHECK(weight BETWEEN 0 AND 100),
 rubric jsonb NOT NULL DEFAULT '{}'::jsonb,
 price_visibility text NOT NULL DEFAULT 'reviewers' CHECK(price_visibility IN('reviewers','committee','hidden')),
 human_only boolean NOT NULL DEFAULT false,
 ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id),
 UNIQUE(matrix_version_id,criterion_key),
 UNIQUE(matrix_version_id,ordinal),
 FOREIGN KEY(matrix_version_id,organization_id) REFERENCES rfpilot.evaluation_matrix_versions(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.requirements(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 requirement_set_id uuid NOT NULL,
 requirement_key text NOT NULL CHECK(requirement_key~'^[a-z][a-z0-9_]{0,119}$'),
 kind text NOT NULL CHECK(kind IN('submission','mandatory','technical','commercial','staffing','references','sustainability_dei','legal_policy','narrative')),
 title text NOT NULL CHECK(char_length(trim(title)) BETWEEN 1 AND 300),
 normalized_text text NOT NULL CHECK(char_length(trim(normalized_text)) BETWEEN 1 AND 8000),
 mandatory_status text NOT NULL DEFAULT 'pending' CHECK(mandatory_status IN('pending','mandatory','not_mandatory')),
 mandatory_reviewed boolean NOT NULL DEFAULT false,
 eligibility boolean NOT NULL DEFAULT false,
 source_kind text NOT NULL CHECK(source_kind IN('canonical_proposal','rendered_rfp')),
 source_locator jsonb NOT NULL CHECK(jsonb_typeof(source_locator)='object'),
 criterion_id uuid,
 criterion_reviewed boolean NOT NULL DEFAULT false,
 importance text NOT NULL DEFAULT 'medium' CHECK(importance IN('high','medium','low')),
 verification_method text NOT NULL DEFAULT 'pending' CHECK(verification_method IN('pending','document','narrative','demonstration','reference','commercial','administrative')),
 group_key text NOT NULL CHECK(char_length(group_key) BETWEEN 1 AND 100),
 parent_requirement_id uuid,
 ordinal integer NOT NULL CHECK(ordinal>=0),
 provenance text NOT NULL DEFAULT 'generated' CHECK(provenance IN('generated','planner')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_external_user_id varchar(24) NOT NULL CHECK(updated_by_external_user_id~'^[0-9a-f]{24}$'),
 UNIQUE(id,organization_id),
 UNIQUE(requirement_set_id,requirement_key),
 UNIQUE(requirement_set_id,ordinal),
 FOREIGN KEY(requirement_set_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(criterion_id,organization_id) REFERENCES rfpilot.evaluation_criteria(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(parent_requirement_id,organization_id) REFERENCES rfpilot.requirements(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.requirement_registry_operations(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
 operation text NOT NULL CHECK(operation IN('generate','edit','approve','supersede')),
 requirement_set_id uuid NOT NULL,
 result_lock_version integer NOT NULL CHECK(result_lock_version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(requirement_set_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT
);

ALTER TABLE rfpilot.requirement_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirement_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_matrix_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_matrix_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evaluation_criteria FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirement_registry_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.requirement_registry_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_requirement_sets ON rfpilot.requirement_sets USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_evaluation_matrix_versions ON rfpilot.evaluation_matrix_versions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_evaluation_criteria ON rfpilot.evaluation_criteria USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_requirements ON rfpilot.requirements USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_requirement_registry_operations ON rfpilot.requirement_registry_operations USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());

CREATE INDEX requirement_sets_proposal_idx ON rfpilot.requirement_sets(organization_id,proposal_reference_id,version DESC);
CREATE INDEX requirement_sets_approved_idx ON rfpilot.requirement_sets(organization_id,proposal_reference_id,approved_at DESC) WHERE status='approved';
CREATE INDEX requirements_set_group_idx ON rfpilot.requirements(requirement_set_id,group_key,ordinal);
CREATE INDEX requirements_criterion_idx ON rfpilot.requirements(criterion_id) WHERE criterion_id IS NOT NULL;
CREATE INDEX evaluation_criteria_matrix_idx ON rfpilot.evaluation_criteria(matrix_version_id,ordinal);

CREATE FUNCTION rfpilot.guard_requirement_registry_child_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen boolean;
BEGIN
 IF TG_TABLE_NAME='evaluation_criteria' THEN
  SELECT m.status<>'draft' INTO frozen FROM rfpilot.evaluation_matrix_versions m WHERE m.id=OLD.matrix_version_id;
 ELSE
  SELECT s.status IN('approved','superseded') INTO frozen FROM rfpilot.requirement_sets s WHERE s.id=OLD.requirement_set_id;
 END IF;
 IF coalesce(frozen,false) THEN RAISE EXCEPTION 'approved requirement registry records are immutable'; END IF;
 RETURN OLD;
END$$;
CREATE TRIGGER requirements_frozen BEFORE UPDATE OR DELETE ON rfpilot.requirements FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_requirement_registry_child_mutation();
CREATE TRIGGER evaluation_criteria_frozen BEFORE UPDATE OR DELETE ON rfpilot.evaluation_criteria FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_requirement_registry_child_mutation();

CREATE FUNCTION rfpilot.guard_requirement_set_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status IN('approved','superseded') THEN RAISE EXCEPTION 'approved requirement sets are immutable'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.status='approved' AND NOT(
  NEW.status='superseded' AND
  NEW.superseded_by_id IS NOT NULL AND
  (to_jsonb(NEW)-ARRAY['status','superseded_by_id','superseded_at','updated_at'])=
  (to_jsonb(OLD)-ARRAY['status','superseded_by_id','superseded_at','updated_at'])
 ) THEN RAISE EXCEPTION 'approved requirement sets are immutable'; END IF;
 IF OLD.status='superseded' THEN RAISE EXCEPTION 'superseded requirement sets are immutable'; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER requirement_sets_frozen BEFORE UPDATE OR DELETE ON rfpilot.requirement_sets FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_requirement_set_mutation();

CREATE FUNCTION rfpilot.guard_matrix_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'draft' THEN RAISE EXCEPTION 'approved evaluation matrices are immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END$$;
CREATE TRIGGER evaluation_matrix_versions_frozen BEFORE UPDATE OR DELETE ON rfpilot.evaluation_matrix_versions FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_matrix_mutation();
