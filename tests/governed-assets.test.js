require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  GOVERNED_ASSET_TYPES,
  parseGovernedAssetListFilters,
  parseGovernedAssetUpdate,
  parseReplacementActivation,
} = require("../src/modules/governance/domain");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("governance filters are bounded and paginated", () => {
  assert.equal(GOVERNED_ASSET_TYPES.length, 6);
  assert.deepEqual(
    parseGovernedAssetListFilters({
      assetType: "knowledge_release",
      approvalState: "approved",
      lifecycleState: "active",
      dueWithinDays: "30",
      limit: "500",
      offset: "25",
    }),
    {
      assetType: "knowledge_release",
      approvalState: "approved",
      lifecycleState: "active",
      dueWithinDays: 30,
      limit: 50,
      offset: 25,
    },
  );
  assert.throws(
    () => parseGovernedAssetListFilters({ dueWithinDays: 366 }),
    /between 0 and 365/,
  );
  assert.throws(
    () => parseGovernedAssetListFilters({ assetType: "raw_prompt" }),
    /assetType is invalid/,
  );
});

test("governance metadata and replacement inputs are strict and versioned", () => {
  const update = parseGovernedAssetUpdate({
    expectedRevision: 2,
    ownerExternalUserId: "507f1f77bcf86cd799439011",
    productArea: "proposal_guidance",
    locale: "en-US",
    sourceReference: "Product contract v12",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    reviewDueAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    approvalState: "approved",
    lifecycleState: "active",
    lastVerifiedApplicationRelease: "dashboard-2026.08.1",
  });
  assert.equal(update.expectedRevision, 2);
  assert.equal(update.productArea, "proposal_guidance");
  assert.equal(update.expiresAt, null);
  assert.throws(
    () =>
      parseGovernedAssetUpdate({
        expectedRevision: 1,
        sourceReference: "x".repeat(301),
      }),
    /sourceReference is invalid/,
  );
  assert.deepEqual(
    parseReplacementActivation({
      replacementGovernedAssetId:
        "019fba11-86bc-7e54-ae18-c76d06905a0f",
      expectedRevision: 4,
      replacementExpectedRevision: 1,
    }),
    {
      replacementGovernedAssetId:
        "019fba11-86bc-7e54-ae18-c76d06905a0f",
      expectedRevision: 4,
      replacementExpectedRevision: 1,
    },
  );
});

test("migration creates tenant-isolated metadata, immutable audit, triggers, and safe backfill", () => {
  const migration = read("migrations/postgres/035_governed_assets.up.sql");
  assert.match(migration, /CREATE TABLE rfpilot\.governed_assets/);
  assert.match(migration, /owner_external_user_id/);
  assert.match(migration, /product_area/);
  assert.match(migration, /locale/);
  assert.match(migration, /source_reference/);
  assert.match(migration, /review_due_at/);
  assert.match(migration, /last_verified_application_release/);
  assert.match(migration, /replacement_asset_id/);
  assert.match(migration, /approval_state/);
  assert.match(migration, /lifecycle_state/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /governed_asset_events_immutable/);
  assert.match(migration, /now\(\)\+interval '90 days'/);
  assert.match(migration, /legacy-migration-035/);
  assert.match(migration, /register_governed_asset/);
});

test("unapproved, revoked, retired, future, and expired assets are excluded at use time", () => {
  const retrieval = read(
    "src/modules/knowledgeRetrieval/postgresKnowledgeRetrievalRepository.ts",
  );
  const investment = read(
    "src/modules/investment/postgresInvestmentRepository.ts",
  );
  for (const source of [retrieval, investment]) {
    assert.match(source, /JOIN rfpilot\.governed_assets/);
    assert.match(source, /approval_state='approved'/);
    assert.match(source, /lifecycle_state='active'/);
    assert.match(source, /effective_at<=now\(\)/);
    assert.match(source, /expires_at IS NULL OR .*expires_at>now\(\)/);
  }
  for (const type of [
    "pricing_record",
    "expert_rule",
    "pricing_regional_factor",
    "pricing_modifier",
    "pricing_confidence_rule",
  ]) {
    assert.match(investment, new RegExp(`asset_type='${type}'`));
  }
});

test("replacement activation is explicit, same-type, eligible, versioned, and audited", () => {
  const repository = read(
    "src/modules/governance/postgresGovernanceRepository.ts",
  );
  assert.match(repository, /activateReplacement/);
  assert.match(repository, /current\.asset_type !== replacement\.asset_type/);
  assert.match(repository, /replacement\.approval_state !== "approved"/);
  assert.match(repository, /replacement\.lifecycle_state !== "active"/);
  assert.match(repository, /REPLACEMENT_NOT_ELIGIBLE/);
  assert.match(repository, /replacement_activated/);
  assert.match(repository, /governed_asset\.\$\{values\.eventType\}/);
});

test("existing approval paths synchronize governance and feedback cannot publish", () => {
  const pricing = read(
    "src/modules/pricing/postgresPricingRepository.ts",
  );
  const knowledge = read(
    "src/modules/knowledgeReview/postgresKnowledgeReviewRepository.ts",
  );
  const feedback = read(
    "src/modules/platformAssistant/postgresAssistantRepository.ts",
  );
  assert.match(pricing, /syncGovernanceState/);
  assert.match(knowledge, /replacement_activated/);
  assert.match(knowledge, /approval_state='revoked'/);
  const feedbackSection = feedback.slice(
    feedback.indexOf("submitFeedback(input)"),
    feedback.indexOf("recordProductEvent(input)"),
  );
  assert.doesNotMatch(
    feedbackSection,
    /governed_assets|knowledge_releases|expert_rules|pricing_records/,
  );
});

test("governance routes require security administration and preserve historical reports", () => {
  const route = read("routes/governedAssetRoute.ts");
  const server = read("server.ts");
  const investment = read(
    "src/modules/investment/postgresInvestmentRepository.ts",
  );
  assert.equal(
    (route.match(/authorizeAction\("security:admin"\)/g) || []).length,
    4,
  );
  assert.match(server, /governedAssetRoutes/);
  assert.match(investment, /pricing_release_version/);
  assert.match(investment, /rule_release_version/);
  assert.doesNotMatch(
    investment,
    /UPDATE rfpilot\.investment_guidance_reports/,
  );
});
