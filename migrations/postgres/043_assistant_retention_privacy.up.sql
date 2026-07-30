ALTER TABLE rfpilot.assistant_threads
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_after timestamptz;

ALTER TABLE rfpilot.assistant_threads
  ADD CONSTRAINT assistant_threads_deletion_window_check
  CHECK (
    (deleted_at IS NULL AND purge_after IS NULL) OR
    (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after > deleted_at)
  );

CREATE INDEX assistant_threads_pending_purge_idx
  ON rfpilot.assistant_threads(organization_id, purge_after, id)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE rfpilot.assistant_retention_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'retired')),
  conversation_retention_days integer NOT NULL DEFAULT 365
    CHECK (conversation_retention_days BETWEEN 30 AND 3650),
  deletion_grace_days integer NOT NULL DEFAULT 30
    CHECK (deletion_grace_days BETWEEN 7 AND 90),
  feedback_retention_days integer NOT NULL DEFAULT 730
    CHECK (feedback_retention_days BETWEEN 30 AND 3650),
  analytics_retention_days integer NOT NULL DEFAULT 400
    CHECK (analytics_retention_days BETWEEN 30 AND 3650),
  analysis_retention_days integer NOT NULL DEFAULT 730
    CHECK (analysis_retention_days BETWEEN 30 AND 3650),
  audit_retention_days integer NOT NULL DEFAULT 2555
    CHECK (audit_retention_days BETWEEN 365 AND 3650),
  provider_storage_mode text NOT NULL DEFAULT 'application_managed'
    CHECK (provider_storage_mode IN ('application_managed', 'provider_zero_retention')),
  policy_version text NOT NULL DEFAULT 'assistant-retention-policy.v1'
    CHECK (char_length(policy_version) BETWEEN 1 AND 100),
  approved_by_external_user_id varchar(24)
    CHECK (
      approved_by_external_user_id IS NULL OR
      approved_by_external_user_id ~ '^[0-9a-f]{24}$'
    ),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id),
  CHECK (
    (status = 'approved') =
    (approved_by_external_user_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE rfpilot.assistant_deletion_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL,
  actor_external_user_id varchar(24) NOT NULL
    CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'restored', 'purged')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  restored_at timestamptz,
  purged_at timestamptz,
  correlation_id text NOT NULL
    CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND restored_at IS NULL AND purged_at IS NULL) OR
    (status = 'restored' AND restored_at IS NOT NULL AND purged_at IS NULL) OR
    (status = 'purged' AND restored_at IS NULL AND purged_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX assistant_deletion_requests_pending_idx
  ON rfpilot.assistant_deletion_requests(organization_id, thread_id)
  WHERE status = 'pending';
CREATE INDEX assistant_deletion_requests_owner_idx
  ON rfpilot.assistant_deletion_requests(
    organization_id, actor_external_user_id, requested_at DESC
  );

CREATE TABLE rfpilot.assistant_legal_holds (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  resource_type text NOT NULL
    CHECK (resource_type IN (
      'organization',
      'assistant_thread',
      'proposal_reference',
      'audit_record'
    )),
  resource_id text NOT NULL
    CHECK (char_length(resource_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released')),
  hold_reference text NOT NULL
    CHECK (char_length(hold_reference) BETWEEN 1 AND 200),
  placed_by_external_user_id varchar(24) NOT NULL
    CHECK (placed_by_external_user_id ~ '^[0-9a-f]{24}$'),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by_external_user_id varchar(24)
    CHECK (
      released_by_external_user_id IS NULL OR
      released_by_external_user_id ~ '^[0-9a-f]{24}$'
    ),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, resource_type, resource_id, hold_reference),
  CHECK (
    (status = 'active' AND released_by_external_user_id IS NULL AND released_at IS NULL) OR
    (status = 'released' AND released_by_external_user_id IS NOT NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX assistant_legal_holds_active_idx
  ON rfpilot.assistant_legal_holds(
    organization_id, resource_type, resource_id
  )
  WHERE status = 'active';

ALTER TABLE rfpilot.assistant_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_retention_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_deletion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_legal_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_assistant_retention_policies
  ON rfpilot.assistant_retention_policies
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_assistant_deletion_requests
  ON rfpilot.assistant_deletion_requests
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_assistant_legal_holds
  ON rfpilot.assistant_legal_holds
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

COMMENT ON TABLE rfpilot.assistant_retention_policies IS
  'Policy is inert until explicitly approved. Cleanup must fail closed otherwise.';
COMMENT ON TABLE rfpilot.assistant_legal_holds IS
  'Extension point only: active holds prevent purge but never shorten retention.';
