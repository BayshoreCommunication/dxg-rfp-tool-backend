-- Vendor-analysis findings cite evidence ids like "vendor-fragment-3", but
-- nothing about those fragments was ever stored: the ids are positions in an
-- array that exists only for the duration of the run. Extraction persists
-- source_version_id, fragment_id, locator and content_checksum for exactly this
-- reason, so a candidate can be traced back to the words that produced it.
-- Vendor findings could not be, which is why the UI renders no provenance at
-- all while docs/AI_LAYER.md describes them as cited findings.
--
-- Mirrors proposal_context_evidence. The excerpt is kept deliberately short: it
-- is enough to show a reviewer what was cited without turning this table into a
-- second copy of the vendor's documents.
CREATE TABLE rfpilot.vendor_analysis_evidence (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES rfpilot.vendor_analysis_runs(id) ON DELETE RESTRICT,
  fragment_id text NOT NULL,
  -- 'message' for the vendor's covering note, or the storage object key for a
  -- parsed document, so a reviewer can tell which artefact a finding came from.
  origin text NOT NULL,
  locator jsonb NOT NULL,
  excerpt text NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 1000),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 199),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, fragment_id)
);

ALTER TABLE rfpilot.vendor_analysis_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.vendor_analysis_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_vendor_analysis_evidence ON rfpilot.vendor_analysis_evidence
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

CREATE INDEX vendor_analysis_evidence_run_idx ON rfpilot.vendor_analysis_evidence (run_id, ordinal);

-- Deliberately NOT given a BEFORE UPDATE OR DELETE immutability trigger. Every
-- table that got one is now exempted again in migration 027 so retention can
-- expire it; adding one here would only have to be undone. The retention sweep
-- deletes these with their run.
