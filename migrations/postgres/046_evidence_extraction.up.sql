CREATE UNIQUE INDEX document_sources_org_id_uq
  ON rfpilot.document_sources(organization_id,id);
CREATE UNIQUE INDEX ai_jobs_org_id_uq
  ON rfpilot.ai_jobs(organization_id,id);

CREATE TABLE rfpilot.source_extraction_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL,
  document_source_id uuid,
  vendor_submission_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_submission_version_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_document_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('document','cover_message')),
  source_label text NOT NULL CHECK (char_length(source_label) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 200),
  source_checksum char(64) NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 100),
  job_id uuid UNIQUE,
  reused_from_run_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','unreadable','failed')),
  extraction_method text CHECK (extraction_method IS NULL OR extraction_method IN ('native','native_with_ocr','ocr')),
  native_parser text,
  native_parser_version text,
  ocr_provider text,
  ocr_provider_version text,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  character_count integer NOT NULL DEFAULT 0 CHECK (character_count >= 0),
  fragment_count integer NOT NULL DEFAULT 0 CHECK (fragment_count >= 0),
  table_count integer NOT NULL DEFAULT 0 CHECK (table_count >= 0),
  coverage numeric(6,5) NOT NULL DEFAULT 0 CHECK (coverage BETWEEN 0 AND 1),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  safe_error_code text,
  output_checksum char(64) CHECK (output_checksum IS NULL OR output_checksum ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id)
);
ALTER TABLE rfpilot.source_extraction_runs ADD CONSTRAINT source_extraction_no_self_reuse
  CHECK (reused_from_run_id IS NULL OR reused_from_run_id <> id);
ALTER TABLE rfpilot.source_extraction_runs
  ADD CONSTRAINT source_extraction_proposal_tenant_fk
    FOREIGN KEY (organization_id,proposal_reference_id)
    REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT source_extraction_document_tenant_fk
    FOREIGN KEY (organization_id,document_source_id)
    REFERENCES rfpilot.document_sources(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT source_extraction_job_tenant_fk
    FOREIGN KEY (organization_id,job_id)
    REFERENCES rfpilot.ai_jobs(organization_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT source_extraction_reuse_tenant_fk
    FOREIGN KEY (organization_id,reused_from_run_id)
    REFERENCES rfpilot.source_extraction_runs(organization_id,id) ON DELETE RESTRICT;

CREATE TABLE rfpilot.evidence_fragments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL CHECK (kind IN ('paragraph','line','table_row','cover_message')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 50000),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  trust_class text NOT NULL DEFAULT 'untrusted_vendor_content' CHECK (trust_class = 'untrusted_vendor_content'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extraction_run_id, ordinal),
  FOREIGN KEY (organization_id,extraction_run_id)
    REFERENCES rfpilot.source_extraction_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evidence_tables (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_key text NOT NULL CHECK (char_length(table_key) BETWEEN 1 AND 150),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 255),
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  row_count integer NOT NULL CHECK (row_count >= 0),
  column_count integer NOT NULL CHECK (column_count >= 0),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extraction_run_id, table_key),
  UNIQUE (extraction_run_id, ordinal),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,extraction_run_id)
    REFERENCES rfpilot.source_extraction_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.evidence_table_cells (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  evidence_table_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index >= 1),
  column_index integer NOT NULL CHECK (column_index >= 1),
  row_span integer NOT NULL DEFAULT 1 CHECK (row_span BETWEEN 1 AND 1000),
  column_span integer NOT NULL DEFAULT 1 CHECK (column_span BETWEEN 1 AND 1000),
  content text NOT NULL CHECK (char_length(content) <= 50000),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  is_header boolean NOT NULL DEFAULT false,
  locator jsonb NOT NULL CHECK (jsonb_typeof(locator) = 'object'),
  trust_class text NOT NULL DEFAULT 'untrusted_vendor_content' CHECK (trust_class = 'untrusted_vendor_content'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_table_id, row_index, column_index),
  FOREIGN KEY (organization_id,evidence_table_id)
    REFERENCES rfpilot.evidence_tables(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX source_extraction_version_idx ON rfpilot.source_extraction_runs
  (organization_id, vendor_submission_version_mongo_id, created_at DESC);
CREATE INDEX source_extraction_reuse_idx ON rfpilot.source_extraction_runs
  (organization_id, source_checksum, policy_version, status);
CREATE INDEX evidence_fragments_run_idx ON rfpilot.evidence_fragments (extraction_run_id, ordinal);
CREATE INDEX evidence_tables_run_idx ON rfpilot.evidence_tables (extraction_run_id, ordinal);
CREATE INDEX evidence_cells_table_idx ON rfpilot.evidence_table_cells (evidence_table_id, row_index, column_index);

ALTER TABLE rfpilot.source_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.source_extraction_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_fragments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_fragments FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_table_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.evidence_table_cells FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_source_extraction_runs ON rfpilot.source_extraction_runs
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_evidence_fragments ON rfpilot.evidence_fragments
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_evidence_tables ON rfpilot.evidence_tables
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_evidence_table_cells ON rfpilot.evidence_table_cells
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.guard_extracted_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'extracted evidence is immutable';
END $$;
CREATE TRIGGER evidence_fragments_immutable BEFORE UPDATE ON rfpilot.evidence_fragments
  FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_extracted_evidence_update();
CREATE TRIGGER evidence_tables_immutable BEFORE UPDATE ON rfpilot.evidence_tables
  FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_extracted_evidence_update();
CREATE TRIGGER evidence_table_cells_immutable BEFORE UPDATE ON rfpilot.evidence_table_cells
  FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_extracted_evidence_update();
