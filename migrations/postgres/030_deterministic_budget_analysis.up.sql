ALTER TABLE rfpilot.investment_guidance_reports
  ADD COLUMN calculation_version text NOT NULL DEFAULT 'deterministic-budget.v1',
  ADD COLUMN pricing_release_version text NOT NULL DEFAULT 'legacy-unversioned',
  ADD COLUMN rule_release_version text NOT NULL DEFAULT 'legacy-unversioned',
  ADD COLUMN budget_analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  ALTER COLUMN engine_version SET DEFAULT 'dxg-av-pricing-engine.v3';

ALTER TABLE rfpilot.investment_guidance_reports
  ADD CONSTRAINT investment_guidance_calculation_version_check
    CHECK (char_length(calculation_version) BETWEEN 1 AND 100),
  ADD CONSTRAINT investment_guidance_pricing_release_version_check
    CHECK (char_length(pricing_release_version) BETWEEN 1 AND 100),
  ADD CONSTRAINT investment_guidance_rule_release_version_check
    CHECK (char_length(rule_release_version) BETWEEN 1 AND 100),
  ADD CONSTRAINT investment_guidance_budget_analysis_object_check
    CHECK (jsonb_typeof(budget_analysis) = 'object');
