require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_QUALITY_MAX_DAYS,
  ASSISTANT_QUALITY_MINIMUM_SAMPLE,
  ASSISTANT_QUALITY_REPORT_SCHEMA_VERSION,
  parseAssistantQualityFilters,
} = require("../src/modules/platformAssistant/assistantQualityReport");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("quality filters default to a bounded 30-day window", () => {
  assert.deepEqual(
    parseAssistantQualityFilters({}, new Date("2026-07-29T10:00:00.000Z")),
    {
      from: "2026-06-30",
      to: "2026-07-29",
      days: 30,
      organizationCohort: null,
      model: null,
      promptVersion: null,
      knowledgeVersion: null,
      intent: null,
      findingCategory: null,
    },
  );
  assert.equal(ASSISTANT_QUALITY_MINIMUM_SAMPLE, 5);
  assert.equal(ASSISTANT_QUALITY_MAX_DAYS, 90);
  assert.equal(
    ASSISTANT_QUALITY_REPORT_SCHEMA_VERSION,
    "assistant-quality-report.v1",
  );
});

test("quality filters allow only bounded dates and controlled dimensions", () => {
  const parsed = parseAssistantQualityFilters({
    from: "2026-07-01",
    to: "2026-07-29",
    organizationCohort: "test_default",
    model: "gpt-5-mini",
    promptVersion: "platform-assistant.v5",
    knowledgeVersion: "knowledge-v4",
    intent: "form_field_help",
    findingCategory: "schedule",
  });
  assert.equal(parsed.days, 29);
  assert.equal(parsed.intent, "form_field_help");
  assert.equal(parsed.findingCategory, "schedule");
  assert.throws(
    () =>
      parseAssistantQualityFilters({
        from: "2026-01-01",
        to: "2026-07-29",
      }),
    /between 1 and 90 days/,
  );
  assert.throws(
    () => parseAssistantQualityFilters({ intent: "show_raw_prompts" }),
    /intent filter is invalid/,
  );
  assert.throws(
    () => parseAssistantQualityFilters({ model: "x';DROP TABLE users;--" }),
    /filter is invalid/,
  );
});

test("quality report is aggregate-only, sample protected, bounded, and audited", () => {
  const source = read(
    "src/modules/platformAssistant/assistantQualityReport.ts",
  );
  assert.match(source, /ASSISTANT_QUALITY_MINIMUM_SAMPLE = 5/);
  assert.match(source, /ASSISTANT_QUALITY_MAX_DAYS = 90/);
  assert.match(source, /HAVING count\(\*\)[\s\S]*ASSISTANT_QUALITY_MINIMUM_SAMPLE/);
  assert.match(source, /LIMIT 50/);
  assert.match(source, /assistant_quality_report_viewed/);
  assert.match(source, /conversationsIncluded: false/);
  assert.match(source, /directIdentifiersIncluded: false/);
  assert.match(source, /citationValidityRate/);
  assert.match(source, /unavailableApprovedPriceCategories/);
  assert.doesNotMatch(
    source,
    /SELECT\s+.*\b(content|raw_prompt|raw_response|provider_payload)\b/i,
  );
});

test("quality indexes cover the bounded filter and finding queries", () => {
  const up = read(
    "migrations/postgres/034_assistant_quality_indexes.up.sql",
  );
  const down = read(
    "migrations/postgres/034_assistant_quality_indexes.down.sql",
  );
  assert.match(up, /assistant_product_events_filter_idx/);
  assert.match(up, /organization_id,[\s\S]*occurred_at DESC/);
  assert.match(up, /assistant_product_events_finding_idx/);
  assert.match(up, /WHERE finding_category IS NOT NULL/);
  assert.match(down, /DROP INDEX IF EXISTS/);
});

test("quality endpoint is restricted to security administrators", () => {
  const route = read("routes/platformAssistantRoute.ts");
  const controller = read("controller/platformAssistantController.ts");
  assert.match(
    route,
    /"\/ai\/assistant-quality",[\s\S]{0,180}authenticate,[\s\S]{0,180}authorizeAction\("security:admin"\)/,
  );
  assert.match(controller, /parseAssistantQualityFilters/);
  assert.match(controller, /assistantQualityReport/);
});
