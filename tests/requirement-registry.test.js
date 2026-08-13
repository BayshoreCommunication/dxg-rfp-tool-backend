const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateCriteria, generateRequirements } = require("../src/modules/requirementRegistry/generator");
const { validateForApproval, parseRequirementUpdate } = require("../src/modules/requirementRegistry/domain");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("requirement generation is complete, deterministic, and excludes private proposal fields", () => {
  const proposal = {
    event: { eventName: "Annual conference", attendeeCount: 450, recordingAllowed: false },
    roomByRoom: Array.from({ length: 90 }, (_, index) => ({ roomFunction: `Breakout ${index + 1}` })),
    budget: {
      estimatedAvBudget: "Production",
      evaluationMatrix: { technicalApproach: 50, pricing: 50 },
      evaluationMatrixConfirmed: true,
    },
    contact: { contactEmail: "private@example.com" },
    uploads: { venueDocs: ["private/storage/key.pdf"] },
  };
  const first = generateRequirements(proposal);
  const second = generateRequirements(proposal);
  assert.ok(first.length > 90, "registry generation has no vendor-analysis cap");
  assert.deepEqual(first, second, "stable input produces stable requirement keys and ordering");
  assert.ok(first.some((item) => item.text === "No"), "false is preserved as an explicit requirement value");
  assert.ok(first.every((item) => !JSON.stringify(item).includes("private@example.com")));
  assert.ok(first.every((item) => !JSON.stringify(item).includes("private/storage")));
  assert.ok(first.every((item) => item.sourceLocator.path?.startsWith("/content/")));
});

test("accepted rendered RFP narrative retains an exact source locator", () => {
  const [item] = generateRequirements({}, [{
    runId: "018f47b0-1111-7111-8111-111111111111",
    runChecksum: "a".repeat(64),
    sectionKey: "vendor_terms",
    paragraphId: "018f47b0-2222-7222-8222-222222222222",
    ordinal: 2,
    text: "Vendors must submit a complete staffing plan.",
  }]);
  assert.equal(item.sourceKind, "rendered_rfp");
  assert.equal(item.sourceLocator.sectionKey, "vendor_terms");
  assert.equal(item.sourceLocator.paragraphId, "018f47b0-2222-7222-8222-222222222222");
  assert.equal(item.text, "Vendors must submit a complete staffing plan.");
});

test("evaluation criteria preserve confirmed proposal weights", () => {
  const criteria = generateCriteria({ budget: { evaluationMatrix: {
    technicalApproach: 30,
    crewExperience: 20,
    hybridVirtual: 10,
    pricing: 25,
    creativeScenic: 5,
    responsiveness: 7,
    sustainabilityDei: 3,
  } } });
  assert.equal(criteria.reduce((sum, criterion) => sum + criterion.weight, 0), 100);
  assert.equal(criteria.find((criterion) => criterion.key === "pricing").name, "Pricing & Value");
  assert.equal(criteria.find((criterion) => criterion.key === "technical_approach").weight, 30);
  assert.ok(criteria.every((criterion) => /^[a-z][a-z0-9_]{0,79}$/.test(criterion.key)), "generated keys satisfy the persisted database contract");
});

test("approval validation blocks unreviewed requirements and invalid weights", () => {
  const validation = validateForApproval({
    weightsConfirmed: false,
    criteria: [{ id: "criterion", weight: 90 }],
    requirements: [{
      mandatory_status: "pending",
      mandatory_reviewed: false,
      source_locator: { path: "/content/event/eventName" },
      criterion_id: null,
      criterion_reviewed: false,
      verification_method: "pending",
    }],
  });
  assert.deepEqual(validation.blocking.map((item) => item.code), [
    "WEIGHTS_NOT_CONFIRMED",
    "WEIGHTS_MUST_TOTAL_100",
    "MANDATORY_REVIEW_REQUIRED",
    "CRITERION_REVIEW_REQUIRED",
    "VERIFICATION_REVIEW_REQUIRED",
  ]);
});

test("approval validation accepts a fully reviewed registry", () => {
  const validation = validateForApproval({
    weightsConfirmed: true,
    criteria: [{ id: "criterion", weight: 100 }],
    requirements: [{
      mandatory_status: "mandatory",
      mandatory_reviewed: true,
      source_locator: { path: "/content/event/eventName" },
      criterion_id: "criterion",
      criterion_reviewed: true,
      verification_method: "document",
    }],
  });
  assert.deepEqual(validation.blocking, []);
});

test("requirement edits accept bounded review fields and reject unsafe values", () => {
  assert.deepEqual(parseRequirementUpdate({
    mandatoryStatus: "mandatory",
    mandatoryReviewed: true,
    criterionReviewed: true,
    verificationMethod: "document",
  }), {
    mandatoryStatus: "mandatory",
    mandatoryReviewed: true,
    criterionReviewed: true,
    verificationMethod: "document",
  });
  assert.throws(() => parseRequirementUpdate({ kind: "invented" }), (error) => error.code === "INVALID_REQUIREMENT_UPDATE");
  assert.throws(() => parseRequirementUpdate({}), (error) => error.code === "INVALID_REQUIREMENT_UPDATE");
});

test("migration enforces tenant isolation, versioning, and approved-row immutability", () => {
  const migration = read("migrations/postgres/045_requirement_registry.up.sql");
  for (const table of ["requirement_sets", "evaluation_matrix_versions", "evaluation_criteria", "requirements", "requirement_registry_operations"])
    assert.ok(migration.includes(`CREATE TABLE rfpilot.${table}`), table);
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 5);
  assert.match(migration, /UNIQUE\(organization_id,proposal_reference_id,version\)/);
  assert.match(migration, /FOREIGN KEY\(requirement_set_id,organization_id\)/, "child references cannot cross tenants");
  assert.match(migration, /FOREIGN KEY\(criterion_id,organization_id\)/, "criterion mapping cannot cross tenants");
  assert.match(migration, /approved requirement registry records are immutable/);
  assert.match(migration, /approved requirement sets are immutable/);
  assert.match(migration, /UNIQUE\(organization_id,idempotency_key\)/);
});

test("requirement registry routes are available by default and separate reads from authorized idempotent writes", () => {
  const routes = read("routes/requirementRegistryRoute.ts");
  const controller = read("controller/requirementRegistryController.ts");
  assert.match(routes, /\/proposals\/:proposalId\/intelligence/);
  assert.match(routes, /requirement-sets\/:setId\/requirements\/:requirementId/);
  assert.match(routes, /authorizeAction\("proposal:read"\)/);
  assert.match(routes, /authorizeAction\("proposal:write"\)/);
  assert.match(controller, /idempotency-key/);
  assert.match(controller, /if-match/);
  assert.doesNotMatch(controller, /PROPOSAL_INTELLIGENCE|REQUIREMENT_REGISTRY_(WRITES_)?DISABLED/);
  assert.doesNotMatch(read("src/modules/requirementRegistry/domain.ts"), /process\.env|aiRuntimeAuthorized/);
});

test("draft requirement edits persist while approved registry children remain immutable", () => {
  const migration = read("migrations/postgres/052_requirement_registry_edit_fix.up.sql");
  assert.match(migration, /approved requirement registry records are immutable/);
  assert.match(migration, /IF TG_OP = 'DELETE' THEN\s+RETURN OLD;/);
  assert.match(migration, /RETURN NEW;/);
});
