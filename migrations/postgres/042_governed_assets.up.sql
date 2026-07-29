CREATE TABLE rfpilot.governed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  asset_type text NOT NULL CHECK (asset_type IN (
    'knowledge_release',
    'expert_rule',
    'pricing_record',
    'pricing_regional_factor',
    'pricing_modifier',
    'pricing_confidence_rule'
  )),
  asset_id uuid NOT NULL,
  owner_external_user_id varchar(24) NOT NULL
    CHECK (owner_external_user_id ~ '^[0-9a-f]{24}$'),
  product_area text NOT NULL
    CHECK (product_area ~ '^[a-z0-9_-]{2,60}$'),
  locale text NOT NULL DEFAULT 'en-US'
    CHECK (locale ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  source_reference text NOT NULL
    CHECK (char_length(source_reference) BETWEEN 1 AND 300),
  effective_at timestamptz NOT NULL,
  review_due_at timestamptz NOT NULL,
  expires_at timestamptz,
  approval_state text NOT NULL
    CHECK (approval_state IN ('draft','approved','revoked')),
  lifecycle_state text NOT NULL
    CHECK (lifecycle_state IN ('active','retired')),
  last_verified_application_release text NOT NULL
    CHECK (char_length(last_verified_application_release) BETWEEN 1 AND 100),
  replacement_asset_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, asset_type, asset_id),
  CHECK (review_due_at >= effective_at),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (replacement_asset_id IS NULL OR replacement_asset_id <> asset_id),
  CHECK (
    approval_state = 'approved' OR lifecycle_state = 'retired' OR
    approval_state = 'draft'
  )
);

CREATE INDEX governed_assets_eligibility_idx
  ON rfpilot.governed_assets(
    organization_id,
    asset_type,
    approval_state,
    lifecycle_state,
    effective_at,
    expires_at
  );
CREATE INDEX governed_assets_review_due_idx
  ON rfpilot.governed_assets(
    organization_id,
    review_due_at,
    asset_type
  );

CREATE TABLE rfpilot.governed_asset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  governed_asset_id uuid NOT NULL
    REFERENCES rfpilot.governed_assets(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN (
    'backfilled',
    'created',
    'metadata_updated',
    'approved',
    'revoked',
    'retired',
    'replacement_activated'
  )),
  actor_external_user_id varchar(24) NOT NULL
    CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  from_revision integer CHECK (from_revision IS NULL OR from_revision >= 1),
  to_revision integer NOT NULL CHECK (to_revision >= 1),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX governed_asset_events_asset_idx
  ON rfpilot.governed_asset_events(
    organization_id,
    governed_asset_id,
    created_at DESC
  );

ALTER TABLE rfpilot.governed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.governed_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.governed_asset_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.governed_asset_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_governed_assets
  ON rfpilot.governed_assets
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_governed_asset_events
  ON rfpilot.governed_asset_events
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.reject_governed_asset_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governed asset events are immutable';
END
$$;
CREATE TRIGGER governed_asset_events_immutable
  BEFORE UPDATE OR DELETE ON rfpilot.governed_asset_events
  FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_governed_asset_event_mutation();

-- Legacy active assets receive a 90-day review window. This keeps currently
-- approved behavior available while making every unverified migration visible
-- and time-bounded for an explicit owner review.
INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,expires_at,
  approval_state,lifecycle_state,last_verified_application_release
)
SELECT organization_id,'knowledge_release',id,approved_by_external_user_id,
  'platform_guidance','en-US','legacy:knowledge_release',effective_at,
  now()+interval '90 days',expires_at,
  CASE WHEN state='revoked' THEN 'revoked' ELSE 'approved' END,
  CASE WHEN state='active' THEN 'active' ELSE 'retired' END,
  'legacy-migration-035'
FROM rfpilot.knowledge_releases;

INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,approval_state,
  lifecycle_state,last_verified_application_release
)
SELECT organization_id,'pricing_record',id,
  coalesce(approved_by_external_user_id,created_by_external_user_id),
  'pricing','en-US','legacy:pricing_record',created_at,
  now()+interval '90 days',
  CASE WHEN status='draft' THEN 'draft' ELSE 'approved' END,
  CASE WHEN status='retired' THEN 'retired' ELSE 'active' END,
  'legacy-migration-035'
FROM rfpilot.pricing_records;

INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,approval_state,
  lifecycle_state,last_verified_application_release
)
SELECT organization_id,'expert_rule',id,updated_by_external_user_id,
  'proposal_guidance','en-US','legacy:expert_rule',created_at,
  now()+interval '90 days',
  CASE WHEN status='draft' THEN 'draft' ELSE 'approved' END,
  CASE WHEN status='retired' THEN 'retired' ELSE 'active' END,
  'legacy-migration-035'
FROM rfpilot.expert_rules;

INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,approval_state,
  lifecycle_state,last_verified_application_release
)
SELECT organization_id,'pricing_regional_factor',id,created_by_external_user_id,
  'pricing','en-US','legacy:pricing_regional_factor',created_at,
  now()+interval '90 days',
  CASE WHEN status='draft' THEN 'draft' ELSE 'approved' END,
  CASE WHEN status='retired' THEN 'retired' ELSE 'active' END,
  'legacy-migration-035'
FROM rfpilot.pricing_regional_factors;

INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,approval_state,
  lifecycle_state,last_verified_application_release
)
SELECT organization_id,'pricing_modifier',id,created_by_external_user_id,
  'pricing','en-US','legacy:pricing_modifier',created_at,
  now()+interval '90 days',
  CASE WHEN status='draft' THEN 'draft' ELSE 'approved' END,
  CASE WHEN status='retired' THEN 'retired' ELSE 'active' END,
  'legacy-migration-035'
FROM rfpilot.pricing_modifiers;

INSERT INTO rfpilot.governed_assets(
  organization_id,asset_type,asset_id,owner_external_user_id,product_area,
  locale,source_reference,effective_at,review_due_at,approval_state,
  lifecycle_state,last_verified_application_release
)
SELECT organization_id,'pricing_confidence_rule',id,created_by_external_user_id,
  'pricing','en-US','legacy:pricing_confidence_rule',created_at,
  now()+interval '90 days',
  CASE WHEN status='draft' THEN 'draft' ELSE 'approved' END,
  CASE WHEN status='retired' THEN 'retired' ELSE 'active' END,
  'legacy-migration-035'
FROM rfpilot.pricing_confidence_rules;

INSERT INTO rfpilot.governed_asset_events(
  organization_id,governed_asset_id,event_type,actor_external_user_id,
  to_revision,correlation_id,metadata
)
SELECT organization_id,id,'backfilled',owner_external_user_id,revision,
  'migration-035',
  jsonb_build_object('reviewWindowDays',90,'source','legacy')
FROM rfpilot.governed_assets;

CREATE FUNCTION rfpilot.register_governed_asset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  governed_type text;
  owner_id text;
  area text;
  approval text;
  lifecycle text;
  effective timestamptz;
  expiry timestamptz;
  governed_id uuid;
BEGIN
  governed_type := CASE TG_TABLE_NAME
    WHEN 'knowledge_releases' THEN 'knowledge_release'
    WHEN 'expert_rules' THEN 'expert_rule'
    WHEN 'pricing_records' THEN 'pricing_record'
    WHEN 'pricing_regional_factors' THEN 'pricing_regional_factor'
    WHEN 'pricing_modifiers' THEN 'pricing_modifier'
    WHEN 'pricing_confidence_rules' THEN 'pricing_confidence_rule'
  END;
  area := CASE
    WHEN governed_type='knowledge_release' THEN 'platform_guidance'
    WHEN governed_type='expert_rule' THEN 'proposal_guidance'
    ELSE 'pricing'
  END;
  owner_id := coalesce(
    row_data->>'approved_by_external_user_id',
    row_data->>'created_by_external_user_id',
    row_data->>'updated_by_external_user_id'
  );
  approval := CASE
    WHEN row_data->>'state'='revoked' THEN 'revoked'
    WHEN row_data->>'status'='draft' THEN 'draft'
    ELSE 'approved'
  END;
  lifecycle := CASE
    WHEN row_data->>'state' IN ('superseded','revoked')
      OR row_data->>'status'='retired' THEN 'retired'
    ELSE 'active'
  END;
  effective := coalesce(
    (row_data->>'effective_at')::timestamptz,
    (row_data->>'created_at')::timestamptz,
    now()
  );
  expiry := (row_data->>'expires_at')::timestamptz;

  INSERT INTO rfpilot.governed_assets(
    organization_id,asset_type,asset_id,owner_external_user_id,product_area,
    locale,source_reference,effective_at,review_due_at,expires_at,
    approval_state,lifecycle_state,last_verified_application_release
  ) VALUES(
    NEW.organization_id,governed_type,NEW.id,owner_id,area,'en-US',
    'created:'||governed_type,effective,effective+interval '180 days',expiry,
    approval,lifecycle,'unverified-new-asset'
  )
  RETURNING id INTO governed_id;

  INSERT INTO rfpilot.governed_asset_events(
    organization_id,governed_asset_id,event_type,actor_external_user_id,
    to_revision,correlation_id,metadata
  ) VALUES(
    NEW.organization_id,governed_id,'created',owner_id,1,
    'governed-asset-trigger','{}'::jsonb
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER knowledge_release_governance
  AFTER INSERT ON rfpilot.knowledge_releases
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
CREATE TRIGGER expert_rule_governance
  AFTER INSERT ON rfpilot.expert_rules
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
CREATE TRIGGER pricing_record_governance
  AFTER INSERT ON rfpilot.pricing_records
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
CREATE TRIGGER pricing_regional_factor_governance
  AFTER INSERT ON rfpilot.pricing_regional_factors
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
CREATE TRIGGER pricing_modifier_governance
  AFTER INSERT ON rfpilot.pricing_modifiers
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
CREATE TRIGGER pricing_confidence_rule_governance
  AFTER INSERT ON rfpilot.pricing_confidence_rules
  FOR EACH ROW EXECUTE FUNCTION rfpilot.register_governed_asset();
