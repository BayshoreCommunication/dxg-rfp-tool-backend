CREATE FUNCTION rfpilot.current_organization_mongo_id() RETURNS varchar(24)
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.organization_mongo_id', true), '')::varchar(24) $$;

ALTER TABLE rfpilot.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_organizations ON rfpilot.organizations
  USING (external_mongo_id = rfpilot.current_organization_mongo_id())
  WITH CHECK (external_mongo_id = rfpilot.current_organization_mongo_id());
