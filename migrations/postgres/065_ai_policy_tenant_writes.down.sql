ALTER POLICY tenant_ai_policies ON rfpilot.ai_provider_policies
  WITH CHECK ((organization_id IS NULL) OR (organization_id = rfpilot.current_organization_id()));
