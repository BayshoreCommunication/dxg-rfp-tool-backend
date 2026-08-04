require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY,
  evaluateAssistantReleaseReadiness,
  parseAssistantPilotReleaseRecord,
  safeOffEnvironmentIssues,
} = require("../src/modules/platformAssistant/releaseReadiness");

const root = path.resolve(__dirname, "..");

const readyRecord = () => ({
  version: "assistant-pilot-release.v1",
  target: "production_limited",
  releaseOwner: "Release Owner",
  productApprover: "Product Approver",
  rollbackAuthority: "Incident Commander",
  supportOwner: "Pilot Support",
  application: {
    backendCommit: "892d30e",
    dashboardCommit: "ab3573a",
    promptVersion: "platform-assistant-prompt.v6",
    migrationsAppliedThrough: "036",
  },
  model: {
    baseline: "gpt-5.4-mini-2026-03-17",
    candidate: "gpt-5.6-terra",
    decision: "baseline_approved",
  },
  governedAssets: {
    knowledgeRelease: "knowledge-release-id",
    ruleRelease: "approved-rules.v1",
    priceRelease: "approved-pricing.v1",
    verifiedForApplicationRelease: true,
  },
  organizationAllowlist: ["64a111111111111111111111"],
  monitoring: {
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-08-08T00:00:00Z",
    onCallOwner: "Pilot On-call",
    alertsConfigured: true,
  },
  privacy: {
    retentionPolicyApproved: true,
    providerTermsReviewed: true,
  },
  evidence: {
    backendCiPassed: true,
    dashboardCiPassed: true,
    evaluationPassed: true,
    migrationsVerified: true,
    smokeTestsPassed: true,
    killSwitchDrillPassed: true,
    rollbackReviewed: true,
    supportWorkflowReviewed: true,
  },
});

test("complete bounded pilot record produces a GO verdict", () => {
  const parsed = parseAssistantPilotReleaseRecord(readyRecord());
  assert.deepEqual(parsed.errors, []);
  assert.equal(evaluateAssistantReleaseReadiness(parsed.record).verdict, "GO");
});

test("missing authority, wildcard scope, or unverified policy fails closed", () => {
  const record = readyRecord();
  record.releaseOwner = "";
  record.organizationAllowlist = ["*"];
  record.privacy.retentionPolicyApproved = false;
  const result = evaluateAssistantReleaseReadiness(record);
  assert.equal(result.verdict, "NO-GO");
  assert.ok(result.blockers.some((item) => item.includes("owners")));
  assert.ok(result.blockers.some((item) => item.includes("organization IDs")));
  assert.ok(result.blockers.some((item) => item.includes("Retention policy")));
});

test("environment inventory keeps secrets server-only and purge gates off", () => {
  const names = ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY.map(
    (item) => item.name,
  );
  for (const required of [
    "OPENAI_API_KEY",
    "AI_SAFETY_IDENTIFIER_SECRET",
    "AI_ANALYTICS_PSEUDONYM_KEY",
    "AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS",
    "AI_ASSISTANT_KILL_SWITCH",
    "AI_RETENTION_PURGE_ENABLED",
    "AI_RETENTION_POLICY_APPROVED",
    "AI_RETENTION_PRODUCTION_EXECUTION_APPROVED",
    "NEXT_PUBLIC_AI_ASSISTANT_ENABLED",
  ]) {
    assert.ok(names.includes(required), required);
  }
  assert.equal(
    ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY.some(
      (item) =>
        item.classification === "secret" &&
        item.name.startsWith("NEXT_PUBLIC_"),
    ),
    false,
  );
  const safe = Object.fromEntries(
    ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY.flatMap((item) =>
      item.safeOffValue === null ? [] : [[item.name, item.safeOffValue]],
    ),
  );
  assert.deepEqual(safeOffEnvironmentIssues(safe), []);
  safe.AI_RETENTION_PURGE_ENABLED = "true";
  assert.match(
    safeOffEnvironmentIssues(safe).join("\n"),
    /AI_RETENTION_PURGE_ENABLED/,
  );
});

test("release artifacts cover every Phase 18 operational requirement", () => {
  const runbook = fs.readFileSync(
    path.join(root, "docs/runbooks/AI_ASSISTANT_PILOT_RELEASE.md"),
    "utf8",
  );
  for (const expected of [
    "Environment inventory",
    "Migration order",
    "Organization allowlist",
    "Model decision",
    "Governed knowledge, rule, and price releases",
    "Smoke tests",
    "Kill-switch drill",
    "Monitoring and alerts",
    "Rollback",
    "Pilot support",
    "Incident classification",
    "Weekly quality review",
    "CONDITIONAL GO",
    "NO-GO for production enablement",
  ]) {
    assert.ok(runbook.includes(expected), expected);
  }
  const template = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "docs/templates/assistant-pilot-release-record.example.json",
      ),
      "utf8",
    ),
  );
  assert.equal(
    evaluateAssistantReleaseReadiness(
      parseAssistantPilotReleaseRecord(template).record,
    ).verdict,
    "NO-GO",
  );
});
