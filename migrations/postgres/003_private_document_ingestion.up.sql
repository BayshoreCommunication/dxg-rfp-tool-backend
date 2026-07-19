CREATE TABLE rfpilot.document_sources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  uploader_external_user_id varchar(24) NOT NULL CHECK (uploader_external_user_id ~ '^[0-9a-f]{24}$'),
  purpose text NOT NULL DEFAULT 'proposal_source' CHECK (purpose IN ('proposal_source','organization_knowledge')),
  confidentiality text NOT NULL DEFAULT 'confidential' CHECK (confidentiality IN ('internal','confidential','restricted')),
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload','uploaded','scanning','ready','blocked','scan_failed','expired','deletion_pending','deleted')),
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rfpilot.document_objects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL UNIQUE REFERENCES rfpilot.document_sources(id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE CHECK (position(chr(10) in object_key) = 0 AND position(chr(13) in object_key) = 0),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  safe_filename text NOT NULL CHECK (length(safe_filename) BETWEEN 1 AND 255),
  declared_mime_type text NOT NULL,
  detected_mime_type text,
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes BETWEEN 1 AND 52428800),
  actual_size_bytes bigint CHECK (actual_size_bytes IS NULL OR actual_size_bytes BETWEEN 1 AND 52428800),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  storage_version text,
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rfpilot.document_scan_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  object_id uuid NOT NULL REFERENCES rfpilot.document_objects(id) ON DELETE RESTRICT,
  scanner text NOT NULL,
  scanner_version text,
  signature_version text,
  status text NOT NULL CHECK (status IN ('clean','infected','error','unavailable')),
  diagnostic_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_sources_proposal_idx ON rfpilot.document_sources (organization_id, proposal_reference_id, created_at DESC);
CREATE INDEX document_sources_status_idx ON rfpilot.document_sources (organization_id, status, updated_at);
CREATE INDEX document_objects_checksum_idx ON rfpilot.document_objects (organization_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX document_scans_object_idx ON rfpilot.document_scan_results (organization_id, object_id, created_at DESC);

ALTER TABLE rfpilot.document_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.document_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.document_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.document_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.document_scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.document_scan_results FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_document_sources ON rfpilot.document_sources
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_document_objects ON rfpilot.document_objects
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_document_scans ON rfpilot.document_scan_results
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.enforce_document_source_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'pending_upload' AND NEW.status IN ('uploaded','expired','blocked','deletion_pending'))
    OR (OLD.status = 'uploaded' AND NEW.status IN ('scanning','blocked','deletion_pending'))
    OR (OLD.status = 'scanning' AND NEW.status IN ('ready','blocked','scan_failed'))
    OR (OLD.status = 'scan_failed' AND NEW.status IN ('scanning','deletion_pending'))
    OR (OLD.status IN ('ready','blocked') AND NEW.status = 'deletion_pending')
    OR (OLD.status = 'deletion_pending' AND NEW.status = 'deleted') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid document source transition: % -> %', OLD.status, NEW.status;
END $$;
CREATE TRIGGER document_source_transition BEFORE UPDATE OF status ON rfpilot.document_sources
FOR EACH ROW EXECUTE FUNCTION rfpilot.enforce_document_source_transition();
