ALTER TABLE rfpilot.knowledge_import_batches DROP CONSTRAINT knowledge_import_batches_status_check;
ALTER TABLE rfpilot.knowledge_import_batches ADD CONSTRAINT knowledge_import_batches_status_check
  CHECK(status IN('draft','uploading','scanning','parse_queued','parsing','needs_review','in_review','submitted','changes_required','approved','failed','blocked','archived'));

CREATE TABLE rfpilot.knowledge_review_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES rfpilot.knowledge_import_batches(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK(version_number > 0),
  status text NOT NULL DEFAULT 'in_review' CHECK(status IN('in_review','submitted','rejected','approved')),
  submitted_by_external_user_id varchar(24) CHECK(submitted_by_external_user_id IS NULL OR submitted_by_external_user_id ~ '^[0-9a-f]{24}$'),
  submitted_checksum char(64) CHECK(submitted_checksum IS NULL OR submitted_checksum ~ '^[0-9a-f]{64}$'),
  effective_at timestamptz,
  expires_at timestamptz,
  created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  UNIQUE(batch_id,version_number),
  CHECK(expires_at IS NULL OR effective_at IS NULL OR expires_at > effective_at)
);
CREATE UNIQUE INDEX knowledge_review_one_editable_idx ON rfpilot.knowledge_review_versions(batch_id) WHERE status='in_review';
CREATE INDEX knowledge_review_versions_list_idx ON rfpilot.knowledge_review_versions(organization_id,status,updated_at DESC);

CREATE TABLE rfpilot.knowledge_fragment_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  review_version_id uuid NOT NULL REFERENCES rfpilot.knowledge_review_versions(id) ON DELETE RESTRICT,
  fragment_id uuid NOT NULL REFERENCES rfpilot.knowledge_source_fragments(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('accepted','rejected','flagged')),
  reason varchar(1000),
  reviewed_by_external_user_id varchar(24) NOT NULL CHECK(reviewed_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(review_version_id,fragment_id),
  CHECK(decision='accepted' OR length(btrim(reason)) BETWEEN 3 AND 1000)
);
CREATE INDEX knowledge_fragment_decisions_review_idx ON rfpilot.knowledge_fragment_decisions(review_version_id,decision);

CREATE TABLE rfpilot.knowledge_approval_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  review_version_id uuid NOT NULL REFERENCES rfpilot.knowledge_review_versions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK(decision IN('approved','rejected')),
  reason varchar(1000),
  decided_by_external_user_id varchar(24) NOT NULL CHECK(decided_by_external_user_id ~ '^[0-9a-f]{24}$'),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(review_version_id),
  CHECK(decision='approved' OR length(btrim(reason)) BETWEEN 3 AND 1000)
);

CREATE TABLE rfpilot.knowledge_releases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES rfpilot.knowledge_import_batches(id) ON DELETE RESTRICT,
  review_version_id uuid NOT NULL UNIQUE REFERENCES rfpilot.knowledge_review_versions(id) ON DELETE RESTRICT,
  release_number integer NOT NULL CHECK(release_number > 0),
  state text NOT NULL DEFAULT 'active' CHECK(state IN('active','superseded','revoked')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  approved_by_external_user_id varchar(24) NOT NULL CHECK(approved_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(batch_id,release_number),
  CHECK(expires_at IS NULL OR expires_at > effective_at)
);
CREATE UNIQUE INDEX knowledge_release_one_active_idx ON rfpilot.knowledge_releases(batch_id) WHERE state='active';
CREATE INDEX knowledge_releases_eligible_idx ON rfpilot.knowledge_releases(organization_id,state,effective_at,expires_at);

CREATE TABLE rfpilot.knowledge_release_fragments (
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES rfpilot.knowledge_releases(id) ON DELETE RESTRICT,
  fragment_id uuid NOT NULL REFERENCES rfpilot.knowledge_source_fragments(id) ON DELETE RESTRICT,
  fragment_checksum char(64) NOT NULL CHECK(fragment_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(release_id,fragment_id)
);

CREATE TABLE rfpilot.knowledge_release_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES rfpilot.knowledge_releases(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN('published','superseded','revoked','restored')),
  actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id ~ '^[0-9a-f]{24}$'),
  reason varchar(1000), correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rfpilot.knowledge_review_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_review_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_fragment_decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_fragment_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_approval_decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_approval_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_releases ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_release_fragments ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_release_fragments FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.knowledge_release_events ENABLE ROW LEVEL SECURITY; ALTER TABLE rfpilot.knowledge_release_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_knowledge_review_versions ON rfpilot.knowledge_review_versions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_fragment_decisions ON rfpilot.knowledge_fragment_decisions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_approval_decisions ON rfpilot.knowledge_approval_decisions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_releases ON rfpilot.knowledge_releases USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_release_fragments ON rfpilot.knowledge_release_fragments USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_knowledge_release_events ON rfpilot.knowledge_release_events USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.reject_submitted_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.status IN('submitted','approved','rejected') THEN RAISE EXCEPTION 'submitted review versions are immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='submitted' THEN
    IF NEW.status NOT IN('approved','rejected') OR
       (to_jsonb(NEW)-'status'-'decided_at'-'updated_at')<>(to_jsonb(OLD)-'status'-'decided_at'-'updated_at')
      THEN RAISE EXCEPTION 'submitted review versions are immutable'; END IF;
  ELSIF TG_OP='UPDATE' AND OLD.status IN('approved','rejected') THEN
    RAISE EXCEPTION 'decided review versions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_review_submitted_immutable BEFORE UPDATE OR DELETE ON rfpilot.knowledge_review_versions FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_submitted_review_mutation();

CREATE FUNCTION rfpilot.reject_release_manifest_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'knowledge release manifests are immutable'; END $$;
CREATE TRIGGER knowledge_release_fragments_immutable BEFORE UPDATE OR DELETE ON rfpilot.knowledge_release_fragments FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_release_manifest_mutation();
