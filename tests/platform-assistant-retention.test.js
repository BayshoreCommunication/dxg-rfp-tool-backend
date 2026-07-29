require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_RETENTION_RESOURCES,
  assistantRetentionExecutionAuthorized,
} = require("../src/modules/platformAssistant/retentionPolicy");
const {
  parseAssistantEvaluationFixtures,
} = require("../src/modules/platformAssistant/evaluation");

const root = path.resolve(__dirname, "..");

test("retention migration is tenant-isolated, recoverable, and hold-aware", () => {
  const up = fs.readFileSync(
    path.join(
      root,
      "migrations/postgres/036_assistant_retention_privacy.up.sql",
    ),
    "utf8",
  );
  const down = fs.readFileSync(
    path.join(
      root,
      "migrations/postgres/036_assistant_retention_privacy.down.sql",
    ),
    "utf8",
  );
  for (const expected of [
    "ADD COLUMN deleted_at",
    "ADD COLUMN purge_after",
    "assistant_retention_policies",
    "assistant_deletion_requests",
    "assistant_legal_holds",
    "status = 'approved'",
    "deletion_grace_days",
    "provider_storage_mode",
    "FORCE ROW LEVEL SECURITY",
    "tenant_assistant_retention_policies",
    "tenant_assistant_deletion_requests",
    "tenant_assistant_legal_holds",
  ]) {
    assert.match(up, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(down, /DROP TABLE IF EXISTS rfpilot\.assistant_legal_holds/);
  assert.match(down, /DROP COLUMN IF EXISTS deleted_at/);
});

test("retention catalog covers every governed Assistant data class", () => {
  assert.deepEqual(
    ASSISTANT_RETENTION_RESOURCES.map((item) => item.resource),
    [
      "conversations",
      "messages_and_citations",
      "feedback",
      "analytics_metadata",
      "proposal_analyses_and_findings",
      "historical_reference_links",
      "field_change_proposals",
      "audit_records",
    ],
  );
  assert.equal(
    ASSISTANT_RETENTION_RESOURCES.find(
      (item) => item.resource === "audit_records",
    )?.cleanup,
    "preserve_until_separate_compliance_approval",
  );
});

test("physical cleanup fails closed without every explicit gate", () => {
  const keys = [
    "NODE_ENV",
    "AI_RETENTION_PURGE_ENABLED",
    "AI_RETENTION_POLICY_APPROVED",
    "AI_RETENTION_PRODUCTION_EXECUTION_APPROVED",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.AI_RETENTION_PURGE_ENABLED = "true";
    process.env.AI_RETENTION_POLICY_APPROVED = "true";
    delete process.env.AI_RETENTION_PRODUCTION_EXECUTION_APPROVED;
    assert.equal(assistantRetentionExecutionAuthorized(), false);
    process.env.AI_RETENTION_PRODUCTION_EXECUTION_APPROVED = "true";
    assert.equal(assistantRetentionExecutionAuthorized(), true);
    process.env.AI_RETENTION_POLICY_APPROVED = "false";
    assert.equal(assistantRetentionExecutionAuthorized(), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("cleanup source scopes one organization and excludes active legal holds", () => {
  const source = fs.readFileSync(
    path.join(
      root,
      "src/modules/platformAssistant/retentionPolicy.ts",
    ),
    "utf8",
  );
  for (const expected of [
    "external_mongo_id=$1",
    "set_config('app.organization_id'",
    "status='approved'",
    "hold.status='active'",
    "hold.resource_type='assistant_thread'",
    "ASSISTANT_RETENTION_EXECUTION_DISABLED",
    "AI_RETENTION_PRODUCTION_EXECUTION_APPROVED",
  ]) {
    assert.ok(source.includes(expected), expected);
  }
  assert.doesNotMatch(source, /DELETE FROM rfpilot\.audit_events/);
});

test("evaluation fixtures cannot claim production conversation provenance", () => {
  const fixtures = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "tests/fixtures/platform-assistant-evaluations.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    fixtures.provenance.containsProductionConversationContent,
    false,
  );
  assert.equal(parseAssistantEvaluationFixtures(fixtures).errors.length, 0);
  const unsafe = structuredClone(fixtures);
  unsafe.provenance.containsProductionConversationContent = true;
  assert.match(
    parseAssistantEvaluationFixtures(unsafe).errors.join("\n"),
    /no production conversation content/,
  );
});

test("thread delete and restore routes retain authentication and permission", () => {
  const routes = fs.readFileSync(
    path.join(root, "routes/platformAssistantRoute.ts"),
    "utf8",
  );
  assert.match(
    routes,
    /router\.delete\([\s\S]*?assistant\/threads\/:threadId[\s\S]*?authenticate[\s\S]*?authorizeAction\("assistant:use"\)[\s\S]*?deleteAssistantThread/,
  );
  assert.match(
    routes,
    /assistant\/threads\/:threadId\/restore[\s\S]*?authenticate[\s\S]*?authorizeAction\("assistant:use"\)[\s\S]*?restoreAssistantThread/,
  );
});
