-- Global AI provider policies (organization_id NULL) choose the provider and model for every
-- organization. Every tenant may read them, but the write check also accepted NULL, so any tenant
-- session could add or change a global policy. Only migrations write policies; with one
-- organization per customer (ORG-106/107), tenants may now write only their own rows.
-- A migration that adds a global policy runs as the table owner, which forced row-level security
-- also binds: wrap the statement in ALTER TABLE ... NO FORCE / FORCE ROW LEVEL SECURITY.
ALTER POLICY tenant_ai_policies ON rfpilot.ai_provider_policies
  WITH CHECK (organization_id = rfpilot.current_organization_id());
