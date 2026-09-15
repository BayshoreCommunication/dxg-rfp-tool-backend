require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ONBOARDING_ACTIVATION_WINDOW_DAYS,
  ONBOARDING_FUNNEL_MAX_DAYS,
  ONBOARDING_FUNNEL_MINIMUM_SAMPLE,
  ONBOARDING_FUNNEL_QUERY,
  ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION,
  onboardingFunnelReport,
  parseOnboardingFunnelFilters,
} = require("../src/modules/dashboard/application/onboardingFunnelReport");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const context = {
  organizationMongoId: "64b000000000000000000001",
  actorUserMongoId: "64b000000000000000000002",
  correlationId: "corr-1",
};

// A fake transaction that answers each statement from a script and records
// every query, so the report's SQL, parameters and audit write can be
// asserted without a database.
const fakeTransaction = (funnelRow) => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM rfpilot.organizations")) {
        return { rows: [{ id: "org-uuid" }] };
      }
      if (sql === ONBOARDING_FUNNEL_QUERY) return { rows: [funnelRow] };
      return { rows: [] };
    },
  };
  const transaction = async (work) => work(client);
  return { transaction, calls };
};

test("funnel filters default to a bounded 90-day window and reject bad input", () => {
  assert.deepEqual(
    parseOnboardingFunnelFilters({}, new Date("2026-09-13T10:00:00.000Z")),
    { from: "2026-06-16", to: "2026-09-13", days: 90 },
  );
  assert.equal(ONBOARDING_FUNNEL_MINIMUM_SAMPLE, 5);
  assert.equal(ONBOARDING_FUNNEL_MAX_DAYS, 180);
  assert.equal(ONBOARDING_ACTIVATION_WINDOW_DAYS, 7);
  assert.equal(ONBOARDING_FUNNEL_REPORT_SCHEMA_VERSION, "onboarding-funnel-report.v1");
  assert.throws(
    () => parseOnboardingFunnelFilters({ from: "2025-01-01", to: "2026-09-13" }),
    /between 1 and 180 days/,
  );
  assert.throws(
    () => parseOnboardingFunnelFilters({ from: "13/09/2026" }),
    /YYYY-MM-DD/,
  );
});

test("funnel report publishes rates and durations only above the sample floor", async () => {
  const { transaction, calls } = fakeTransaction({
    new_accounts: "42",
    legacy_accounts: "2",
    matured_accounts: "30",
    message_within: "18",
    draft_within: "9",
    message_any: "24",
    draft_any: "12",
    p50_message_hours: "3.456",
    p90_message_hours: "70.2",
    p50_draft_hours: "20.04",
    p90_draft_hours: "160",
  });
  const report = await onboardingFunnelReport(
    context,
    { from: "2026-06-16", to: "2026-09-13", days: 90 },
    { transaction, now: () => new Date("2026-09-13T12:00:00.000Z") },
  );

  assert.equal(report.generatedAt, "2026-09-13T12:00:00.000Z");
  assert.equal(report.activationWindowDays, 7);
  assert.deepEqual(report.accounts, {
    started: 40,
    matured: 30,
    notYetMatured: 10,
    legacyExcluded: 2,
  });
  assert.deepEqual(report.firstMessage, {
    withinWindow: 18,
    withinWindowRate: 0.6,
    reachedEver: 24,
    p50Hours: 3.5,
    p90Hours: 70.2,
  });
  assert.deepEqual(report.firstDraft, {
    withinWindow: 9,
    withinWindowRate: 0.3,
    reachedEver: 12,
    p50Hours: 20,
    p90Hours: 160,
  });
  assert.equal(report.privacy.sampleProtected, false);
  assert.equal(report.privacy.directIdentifiersIncluded, false);

  // Tenant context is set before any data is read, the funnel is one
  // statement bound to the organization and the activation window, and the
  // view is audited without identifiers in its metadata.
  assert.match(calls[0].sql, /app\.organization_mongo_id/);
  assert.match(calls[2].sql, /app\.organization_id/);
  const funnel = calls.find((call) => call.sql === ONBOARDING_FUNNEL_QUERY);
  assert.deepEqual(funnel.params, [
    "2026-06-16T00:00:00.000Z",
    "2026-09-13T23:59:59.999Z",
    "org-uuid",
    7,
  ]);
  const audit = calls.find((call) => /onboarding_funnel_report_viewed/.test(call.sql));
  assert.ok(audit);
  assert.equal(audit.params[1], "org-uuid");
  assert.equal(audit.params[2], context.actorUserMongoId);
  assert.deepEqual(JSON.parse(audit.params[5]), {
    schemaVersion: "onboarding-funnel-report.v1",
    from: "2026-06-16",
    to: "2026-09-13",
  });
});

test("funnel report protects small cohorts and counts legacy accounts out", async () => {
  const { transaction } = fakeTransaction({
    new_accounts: "6",
    legacy_accounts: "3",
    matured_accounts: "3",
    message_within: "3",
    draft_within: "1",
    message_any: "3",
    draft_any: "1",
    p50_message_hours: "1",
    p90_message_hours: "2",
    p50_draft_hours: "5",
    p90_draft_hours: "6",
  });
  const report = await onboardingFunnelReport(
    context,
    { from: "2026-09-01", to: "2026-09-13", days: 13 },
    { transaction },
  );
  assert.equal(report.privacy.sampleProtected, true);
  assert.deepEqual(report.accounts, {
    started: null,
    matured: null,
    notYetMatured: null,
    legacyExcluded: 3,
  });
  for (const milestone of [report.firstMessage, report.firstDraft]) {
    assert.deepEqual(milestone, {
      withinWindow: null,
      withinWindowRate: null,
      reachedEver: null,
      p50Hours: null,
      p90Hours: null,
    });
  }
});

test("funnel report fails closed without an active organization projection", async () => {
  const transaction = async (work) =>
    work({ async query() { return { rows: [] }; } });
  await assert.rejects(
    onboardingFunnelReport(context, { from: "2026-09-01", to: "2026-09-13", days: 13 }, { transaction }),
    /Organization data foundation is unavailable/,
  );
});

test("funnel query reads milestones, never message content, and is admin-only", () => {
  assert.match(ONBOARDING_FUNNEL_QUERY, /role = 'user'/);
  assert.match(ONBOARDING_FUNNEL_QUERY, /status = 'succeeded'/);
  assert.match(ONBOARDING_FUNNEL_QUERY, /WHERE NOT legacy/);
  assert.doesNotMatch(ONBOARDING_FUNNEL_QUERY, /\bcontent\b|external_mongo_id AS|email/);
  const route = read("routes/dashboardRoute.ts");
  assert.match(route, /"\/onboarding-funnel"[\s\S]*authorizeAction\("security:admin"\)/);
});
