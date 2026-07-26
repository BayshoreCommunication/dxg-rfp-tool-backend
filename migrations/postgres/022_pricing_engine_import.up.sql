-- Extends the pricing corpus to hold the DXG AV Pricing Engine workbook:
-- model-level SKUs with subcategory/spec, a quantity dimension per unit
-- (per box/day, per sq ft/day, per fixture/day ...), an explicit calibration
-- tier so baseline national estimates are never mistaken for DXG actuals, and
-- the regional/modifier multiplier tables the estimate model stacks.

ALTER TABLE rfpilot.pricing_records DROP CONSTRAINT pricing_records_category_check;
ALTER TABLE rfpilot.pricing_records ADD CONSTRAINT pricing_records_category_check CHECK(category IN(
 'audio','video','lighting','staging','led_wall','projection','breakout_room','general_session','labor',
 'rigging','power','trucking_freight','travel_per_diem','venue_fee','insurance','service_charge_tax',
 'streaming_hybrid','furnishings','production_management','connectivity','expendables','other'));

ALTER TABLE rfpilot.pricing_records DROP CONSTRAINT pricing_records_unit_check;
ALTER TABLE rfpilot.pricing_records ADD CONSTRAINT pricing_records_unit_check CHECK(unit IN(
 'per_day','per_event','per_hour','per_person','per_room','flat','multiplier'));

ALTER TABLE rfpilot.pricing_records
 ADD COLUMN subcategory text CHECK(subcategory IS NULL OR char_length(subcategory)<=100),
 ADD COLUMN spec text CHECK(spec IS NULL OR char_length(spec)<=300),
 ADD COLUMN unit_label text CHECK(unit_label IS NULL OR char_length(unit_label)<=60),
 ADD COLUMN quantity_dimension text CHECK(quantity_dimension IS NULL OR quantity_dimension~'^[a-z0-9_]{1,40}$'),
 ADD COLUMN calibration_tier text NOT NULL DEFAULT 'baseline' CHECK(calibration_tier IN('baseline','calibrated','actual'));

CREATE INDEX pricing_records_category_status_idx ON rfpilot.pricing_records(organization_id,category,status);

-- Regional factor per market. Applies to equipment and labor.
CREATE TABLE rfpilot.pricing_regional_factors(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 market text NOT NULL CHECK(char_length(market) BETWEEN 1 AND 100),
 factor numeric(5,3) NOT NULL CHECK(factor>0 AND factor<=3),
 notes text NOT NULL DEFAULT '' CHECK(char_length(notes)<=300),
 status text NOT NULL DEFAULT 'approved' CHECK(status IN('draft','approved','retired')),
 created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,market)
);

-- Stacked multipliers. `scope` decides what a factor may touch, mirroring the
-- workbook: union -> labor only, in-house/multi-day -> equipment only,
-- service charge -> subtotal.
CREATE TABLE rfpilot.pricing_modifiers(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('union','in_house','multi_day','venue_fee','service_charge','labor_rule')),
 condition_key text NOT NULL CHECK(condition_key~'^[a-z0-9_]{1,60}$'),
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 200),
 factor numeric(6,3) NOT NULL CHECK(factor>=0 AND factor<=10),
 scope text NOT NULL CHECK(scope IN('labor','equipment','subtotal')),
 notes text NOT NULL DEFAULT '' CHECK(char_length(notes)<=300),
 status text NOT NULL DEFAULT 'approved' CHECK(status IN('draft','approved','retired')),
 created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,kind,condition_key)
);

-- Confidence deductions: start at 100 and subtract for each unknown input.
CREATE TABLE rfpilot.pricing_confidence_rules(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 rule_key text NOT NULL CHECK(rule_key~'^[a-z0-9_]{1,60}$'),
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 200),
 deduction integer NOT NULL CHECK(deduction>0 AND deduction<=100),
 reason text NOT NULL DEFAULT '' CHECK(char_length(reason)<=300),
 status text NOT NULL DEFAULT 'approved' CHECK(status IN('draft','approved','retired')),
 created_by_external_user_id varchar(24) NOT NULL CHECK(created_by_external_user_id~'^[0-9a-f]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,rule_key)
);

ALTER TABLE rfpilot.pricing_regional_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.pricing_regional_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.pricing_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.pricing_modifiers FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.pricing_confidence_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.pricing_confidence_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_pricing_regional_factors ON rfpilot.pricing_regional_factors USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_pricing_modifiers ON rfpilot.pricing_modifiers USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_pricing_confidence_rules ON rfpilot.pricing_confidence_rules USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
