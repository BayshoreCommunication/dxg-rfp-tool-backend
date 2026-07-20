CREATE TABLE rfpilot.knowledge_import_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  name varchar(200) NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
  description varchar(2000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','uploading','scanning','parse_queued','parsing','needs_review','failed','blocked','archived')),
  source_type text NOT NULL CHECK(source_type IN('contract','prior_proposal','price_sheet','equipment_list','labor_schedule','operating_guidance','other')),
  market varchar(100), currency char(3) CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  classification text NOT NULL CHECK(classification IN('synthetic','internal','customer_confidential','vendor_confidential','restricted')),
  intended_use varchar(500) NOT NULL CHECK(length(btrim(intended_use)) BETWEEN 3 AND 500),
  observed_from date, observed_to date, notes varchar(2000),
  created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  CHECK(observed_from IS NULL OR observed_to IS NULL OR observed_from<=observed_to),
  CHECK(classification<>'restricted')
);
CREATE INDEX knowledge_batches_list_idx ON rfpilot.knowledge_import_batches(organization_id,created_at DESC);

CREATE TABLE rfpilot.knowledge_import_documents (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES rfpilot.knowledge_import_batches(id) ON DELETE RESTRICT,
  document_source_id uuid NOT NULL REFERENCES rfpilot.document_sources(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scanning' CHECK(status IN('scanning','blocked','parse_queued','parsing','needs_review','failed','archived')),
  sha256 char(64) CHECK(sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'), parser_kind text, parser_version text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,document_source_id)
);
CREATE INDEX knowledge_documents_batch_idx ON rfpilot.knowledge_import_documents(batch_id,created_at);

CREATE TABLE rfpilot.knowledge_parser_runs (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES rfpilot.knowledge_import_documents(id) ON DELETE RESTRICT,
  parser_kind text NOT NULL, parser_version text NOT NULL, status text NOT NULL CHECK(status IN('queued','running','succeeded','failed')),
  diagnostic_code text, fragment_count integer NOT NULL DEFAULT 0 CHECK(fragment_count>=0),
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,parser_kind,parser_version)
);

CREATE TABLE rfpilot.knowledge_source_fragments (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES rfpilot.knowledge_import_documents(id) ON DELETE RESTRICT,
  parser_run_id uuid NOT NULL REFERENCES rfpilot.knowledge_parser_runs(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK(ordinal>=0), content text NOT NULL CHECK(length(content) BETWEEN 1 AND 50000),
  coordinates jsonb NOT NULL, checksum char(64) NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN('unreviewed','flagged','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(parser_run_id,ordinal)
);
CREATE INDEX knowledge_fragments_document_idx ON rfpilot.knowledge_source_fragments(document_id,ordinal);
CREATE INDEX knowledge_fragments_exact_duplicate_idx ON rfpilot.knowledge_source_fragments(organization_id,checksum);

ALTER TABLE rfpilot.knowledge_import_batches ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_import_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_import_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_parser_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_parser_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_source_fragments ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_source_fragments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_knowledge_batches ON rfpilot.knowledge_import_batches USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_documents ON rfpilot.knowledge_import_documents USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_parser_runs ON rfpilot.knowledge_parser_runs USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_fragments ON rfpilot.knowledge_source_fragments USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.reject_knowledge_fragment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'knowledge fragments are immutable'; END $$;
CREATE TRIGGER knowledge_fragments_no_mutation BEFORE UPDATE OR DELETE ON rfpilot.knowledge_source_fragments FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_knowledge_fragment_mutation();
