DROP POLICY IF EXISTS tenant_isolation_organizations ON rfpilot.organizations;
ALTER TABLE rfpilot.organizations NO FORCE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS rfpilot.current_organization_mongo_id();
