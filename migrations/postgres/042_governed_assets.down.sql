DROP TRIGGER IF EXISTS pricing_confidence_rule_governance
  ON rfpilot.pricing_confidence_rules;
DROP TRIGGER IF EXISTS pricing_modifier_governance
  ON rfpilot.pricing_modifiers;
DROP TRIGGER IF EXISTS pricing_regional_factor_governance
  ON rfpilot.pricing_regional_factors;
DROP TRIGGER IF EXISTS pricing_record_governance
  ON rfpilot.pricing_records;
DROP TRIGGER IF EXISTS expert_rule_governance ON rfpilot.expert_rules;
DROP TRIGGER IF EXISTS knowledge_release_governance
  ON rfpilot.knowledge_releases;
DROP FUNCTION IF EXISTS rfpilot.register_governed_asset();
DROP TRIGGER IF EXISTS governed_asset_events_immutable
  ON rfpilot.governed_asset_events;
DROP FUNCTION IF EXISTS rfpilot.reject_governed_asset_event_mutation();
DROP TABLE IF EXISTS rfpilot.governed_asset_events;
DROP TABLE IF EXISTS rfpilot.governed_assets;
