-- DXG's pricing corpus, expert rules and knowledge base are platform assets, not one customer's
-- data. They live in the platform organization (DXG's) and every customer organization reads
-- them; writes stay with the platform organization's own tenant policies. Customer data is never
-- shared: only the tables below get a platform read policy.

ALTER TABLE rfpilot.organizations ADD COLUMN is_platform boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX organizations_single_platform ON rfpilot.organizations ((true)) WHERE is_platform;

-- Every tenant may see that the platform organization exists, so the function below resolves
-- under forced row-level security.
CREATE POLICY platform_organization_visible ON rfpilot.organizations
  FOR SELECT USING (is_platform);

-- NULL until an operator marks the platform (scripts/markPlatformOrganization.ts), so nothing is
-- shared before then.
CREATE FUNCTION rfpilot.platform_organization_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM rfpilot.organizations WHERE is_platform AND status = 'active' LIMIT 1 $$;

CREATE POLICY platform_corpus_read ON rfpilot.pricing_records
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.pricing_modifiers
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.pricing_regional_factors
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.pricing_confidence_rules
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.expert_rules
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
-- governed_assets only ever holds the corpus asset types above and knowledge releases.
CREATE POLICY platform_corpus_read ON rfpilot.governed_assets
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_releases
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_import_batches
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_import_documents
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_release_fragments
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_source_fragments
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
CREATE POLICY platform_corpus_read ON rfpilot.knowledge_fragment_embeddings
  FOR SELECT USING (organization_id = rfpilot.platform_organization_id());
