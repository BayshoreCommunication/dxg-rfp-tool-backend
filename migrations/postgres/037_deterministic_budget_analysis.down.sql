ALTER TABLE rfpilot.investment_guidance_reports
  DROP CONSTRAINT IF EXISTS investment_guidance_calculation_version_check,
  DROP CONSTRAINT IF EXISTS investment_guidance_pricing_release_version_check,
  DROP CONSTRAINT IF EXISTS investment_guidance_rule_release_version_check,
  DROP CONSTRAINT IF EXISTS investment_guidance_budget_analysis_object_check,
  DROP COLUMN IF EXISTS calculation_version,
  DROP COLUMN IF EXISTS pricing_release_version,
  DROP COLUMN IF EXISTS rule_release_version,
  DROP COLUMN IF EXISTS budget_analysis,
  ALTER COLUMN engine_version SET DEFAULT 'investment-rules.v1';
