DROP TABLE IF EXISTS rfpilot.pricing_confidence_rules;
DROP TABLE IF EXISTS rfpilot.pricing_modifiers;
DROP TABLE IF EXISTS rfpilot.pricing_regional_factors;
DROP INDEX IF EXISTS rfpilot.pricing_records_category_status_idx;
ALTER TABLE rfpilot.pricing_records
 DROP COLUMN IF EXISTS calibration_tier,
 DROP COLUMN IF EXISTS quantity_dimension,
 DROP COLUMN IF EXISTS unit_label,
 DROP COLUMN IF EXISTS spec,
 DROP COLUMN IF EXISTS subcategory;
ALTER TABLE rfpilot.pricing_records DROP CONSTRAINT pricing_records_unit_check;
ALTER TABLE rfpilot.pricing_records ADD CONSTRAINT pricing_records_unit_check CHECK(unit IN('per_day','per_event','per_hour','per_person','per_room','flat'));
ALTER TABLE rfpilot.pricing_records DROP CONSTRAINT pricing_records_category_check;
ALTER TABLE rfpilot.pricing_records ADD CONSTRAINT pricing_records_category_check CHECK(category IN('audio','video','lighting','staging','led_wall','projection','breakout_room','general_session','labor','rigging','power','trucking_freight','travel_per_diem','venue_fee','insurance','service_charge_tax','other'));
