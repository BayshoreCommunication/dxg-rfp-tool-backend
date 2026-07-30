const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  computeHistoricalInsights,
  historicalInsightsEnabled,
  HISTORICAL_INSIGHTS_VERSION,
  parseHistoricalReferenceIds,
} = require("../src/modules/historicalInsights/domain");

const current = {
  version: 7,
  event: { eventFormat: "Hybrid", eventName: "Private current name" },
  contact: {
    contactFirstName: "Private",
    contactEmail: "private@example.com",
    contactPhone: "2125550199",
  },
};
const historical = {
  version: 3,
  event: { eventFormat: "In-Person", eventName: "Confidential client gala" },
  venueSchedule: {
    venueCity: "New York",
    showStartDate: "2026-01-01",
    strikeDate: "2026-01-02",
  },
  roomByRoom: [{ roomFunction: "Confidential ballroom", camerasQty: 5 }],
  budget: { amountMinor: 99999999, currency: "USD", evaluationCriteria: "Value" },
  contact: {
    contactFirstName: "Secret Person",
    contactEmail: "secret@example.com",
    contactPhone: "6465550100",
    anythingElse: "Private note",
  },
};

test("historical insight computation is versioned and provenance is reference-scoped", () => {
  const result = computeHistoricalInsights(current, [
    { proposal: historical, proposalVersion: 3 },
  ]);
  assert.equal(result.analysisVersion, HISTORICAL_INSIGHTS_VERSION);
  assert.equal(result.currentProposalVersion, 7);
  assert.deepEqual(result.references, [
    {
      referenceKey: "reference-1",
      label: "Selected reference 1",
      proposalVersion: 3,
    },
  ]);
  assert.ok(result.insights.length > 0);
  assert.ok(
    result.insights.every((insight) =>
      insight.provenance.every(
        (source) =>
          source.source === "selected_historical_reference" &&
          source.referenceKey === "reference-1",
      ),
    ),
  );
});

test("private values, identifiers, notes and exact pricing never enter output", () => {
  const serialized = JSON.stringify(
    computeHistoricalInsights(current, [
      { proposal: historical, proposalVersion: 3 },
    ]),
  );
  for (const prohibited of [
    "Private current name",
    "private@example.com",
    "2125550199",
    "Confidential client gala",
    "Confidential ballroom",
    "99999999",
    "Secret Person",
    "secret@example.com",
    "6465550100",
    "Private note",
    "New York",
  ])
    assert.equal(serialized.includes(prohibited), false, prohibited);
});

test("reference-only sections are suggestions and never copied fields", () => {
  const result = computeHistoricalInsights(current, [
    { proposal: historical, proposalVersion: 3 },
  ]);
  const venue = result.comparisons.find(
    (comparison) => comparison.section === "venueSchedule",
  );
  assert.equal(venue.status, "reference_only");
  const suggestion = result.insights.find(
    (insight) => insight.affectedSection === "venueSchedule",
  );
  assert.equal(suggestion.applicability, "may_apply");
  assert.match(suggestion.detail, /idea, not as a fact/i);
  assert.equal("changes" in result, false);
});

test("shared sections require current-event confirmation", () => {
  const result = computeHistoricalInsights(current, [
    { proposal: historical, proposalVersion: 3 },
  ]);
  const event = result.comparisons.find(
    (comparison) => comparison.section === "event",
  );
  assert.equal(event.status, "exists_in_both");
  const insight = result.insights.find(
    (candidate) => candidate.affectedSection === "event",
  );
  assert.equal(insight.applicability, "needs_confirmation");
  assert.ok(insight.question);
});

test("historical reference selection is explicit, unique and bounded", () => {
  const currentId = "64b000000000000000000001";
  assert.deepEqual(
    parseHistoricalReferenceIds(
      ["64B000000000000000000002", "64b000000000000000000003"],
      currentId,
    ),
    ["64b000000000000000000002", "64b000000000000000000003"],
  );
  assert.throws(
    () => parseHistoricalReferenceIds([], currentId),
    /Select between|Select at least/,
  );
  assert.throws(
    () => parseHistoricalReferenceIds([currentId], currentId),
    /different accessible proposals/,
  );
  assert.throws(
    () =>
      parseHistoricalReferenceIds(
        ["64b000000000000000000002", "64b000000000000000000002"],
        currentId,
      ),
    /different accessible proposals/,
  );
});

test("feature flag remains deny by default and environment authorized", () => {
  const saved = {
    ai: process.env.AI_ENVIRONMENT,
    node: process.env.NODE_ENV,
    flag: process.env.HISTORICAL_INSIGHTS_ENABLED,
  };
  process.env.NODE_ENV = "production";
  delete process.env.AI_ENVIRONMENT;
  process.env.HISTORICAL_INSIGHTS_ENABLED = "true";
  assert.equal(historicalInsightsEnabled(), false);
  process.env.AI_ENVIRONMENT = "staging";
  assert.equal(historicalInsightsEnabled(), true);
  delete process.env.HISTORICAL_INSIGHTS_ENABLED;
  assert.equal(historicalInsightsEnabled(), false);
  for (const [key, value] of [
    ["AI_ENVIRONMENT", saved.ai],
    ["NODE_ENV", saved.node],
    ["HISTORICAL_INSIGHTS_ENABLED", saved.flag],
  ])
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("repository revalidates owner, tenant and archive state on generation and read", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../src/modules/historicalInsights/postgresHistoricalInsightsRepository.ts",
    ),
    "utf8",
  );
  assert.match(source, /userId: actorUserMongoId/);
  assert.match(source, /\.\.\.tenantFilter\(\)/);
  assert.match(source, /isArchived: \{ \$ne: true \}/);
  assert.match(source, /u\.external_mongo_id=\$2/);
  assert.match(source, /await loadActiveOwned\([\s\S]*linked\.rows/);
});

test("routes require authentication, proposal read permission, and rate limiting", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../routes/historicalInsightsRoute.ts"),
    "utf8",
  );
  assert.match(source, /authenticate/);
  assert.match(source, /authorizeAction\("proposal:read"\)/);
  assert.match(source, /securityRateLimit/);
});

test("migration enforces RLS and organization-consistent proposal references", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../migrations/postgres/038_historical_proposal_insights.up.sql",
    ),
    "utf8",
  );
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(
    migration,
    /FOREIGN KEY\(organization_id,current_proposal_reference_id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY\(organization_id,reference_proposal_reference_id\)/,
  );
  assert.match(migration, /ordinal BETWEEN 1 AND 5/);
});

test("stored reports contain structured output, not raw proposal content", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../migrations/postgres/038_historical_proposal_insights.up.sql",
    ),
    "utf8",
  );
  assert.match(migration, /section_comparisons jsonb/);
  assert.match(migration, /insights jsonb/);
  assert.doesNotMatch(migration, /raw_(proposal|content|prompt|response)/i);
});
