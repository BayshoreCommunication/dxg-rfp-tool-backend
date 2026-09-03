const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { generateCriteria, generateRequirements, isPlannerInstructionLocator } = require("../src/modules/requirementRegistry/generator");
const { duplicateRequirementIds, normalizeCriterionWeights, suggestedMandatoryStatus, suggestedVerificationMethod, validateForApproval, parseRequirementUpdate } = require("../src/modules/requirementRegistry/domain");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("requirement generation is complete, deterministic, and excludes private proposal fields", () => {
  const proposal = {
    event: { eventName: "Annual conference", attendeeCount: 450, recordingAllowed: false, sacredConstraints: "Use the venue's exclusive union labor provider." },
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
  assert.ok(first.some((item) => item.text.endsWith(": No")), "false is preserved as an explicit requirement value");
  assert.ok(first.every((item) => !JSON.stringify(item).includes("private@example.com")));
  assert.ok(first.every((item) => !JSON.stringify(item).includes("private/storage")));
  assert.ok(first.every((item) => item.sourceLocator.path?.startsWith("/content/")));
  assert.ok(first.every((item) => !/^\d+$/.test(item.title) && !/: \d+$/.test(item.title)), "array indexes never become requirement titles");
  assert.ok(first.every((item) => item.title !== "Event name"), "descriptive proposal metadata is not scored as a vendor obligation");
  assert.ok(first.some((item) => item.kind === "mandatory" && item.text.includes("exclusive union labor")), "planner-authored non-negotiable constraints are never dropped");
  assert.ok(first.every((item) => item.sourceLocator.provenanceLabel), "canonical requirements identify their planner-authored provenance");
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
  assert.ok(criteria.every((criterion) => criterion.rubric.maximum === 5 && criterion.rubric.anchors.length === 6));
  assert.equal(criteria[0].rubric.anchors.find((anchor) => anchor.score === 3).label, "Meets");
});

test("evaluation criteria provide a complete 100 percent fallback matrix", () => {
  const criteria = generateCriteria({});
  assert.equal(criteria.length, 7);
  assert.equal(criteria.reduce((sum, criterion) => sum + criterion.weight, 0), 100);
  assert.equal(criteria.find((criterion) => criterion.key === "technical_approach").weight, 30);
});

test("approval validation blocks unreviewed requirements and invalid weights", () => {
  const validation = validateForApproval({
    weightsConfirmed: false,
    criteria: [{ id: "criterion", weight: 90 }],
    requirements: [{
      included: true,
      inclusion_reviewed: false,
      normalized_text: "Provide redundant streaming.",
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
    "INCLUSION_REVIEW_REQUIRED",
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
      included: true,
      inclusion_reviewed: true,
      normalized_text: "Provide redundant streaming.",
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

test("approval ignores excluded items but blocks near-duplicate included requirements", () => {
  const base = {
    included: true, inclusion_reviewed: true, mandatory_status: "not_mandatory", mandatory_reviewed: true,
    source_locator: { path: "/content/production" }, criterion_id: "criterion", criterion_reviewed: true,
    verification_method: "document",
  };
  const duplicate = validateForApproval({
    weightsConfirmed: true, criteria: [{ id: "criterion", weight: 100 }], requirements: [
      { ...base, normalized_text: "Vendor must provide a complete technical staffing plan." },
      { ...base, normalized_text: "Provide a complete technical staffing plan" },
      { ...base, included: false, mandatory_status: "pending", mandatory_reviewed: false, criterion_id: null, criterion_reviewed: false, verification_method: "pending", normalized_text: "Internal planning note" },
    ],
  });
  assert.deepEqual(duplicate.blocking.map((item) => item.code), ["DUPLICATE_REQUIREMENTS"]);
});

test("requirement edits accept bounded review fields and reject unsafe values", () => {
  assert.deepEqual(parseRequirementUpdate({
    mandatoryStatus: "mandatory",
    mandatoryReviewed: true,
    criterionReviewed: true,
    verificationMethod: "document",
    included: false,
    inclusionReviewed: true,
  }), {
    mandatoryStatus: "mandatory",
    mandatoryReviewed: true,
    criterionReviewed: true,
    verificationMethod: "document",
    included: false,
    inclusionReviewed: true,
  });
  assert.throws(() => parseRequirementUpdate({ kind: "invented" }), (error) => error.code === "INVALID_REQUIREMENT_UPDATE");
  assert.throws(() => parseRequirementUpdate({}), (error) => error.code === "INVALID_REQUIREMENT_UPDATE");
});

test("automatic preparation balances weights and applies deterministic review defaults", () => {
  const weights = normalizeCriterionWeights([
    { id: "technical", weight: 31, ordinal: 0 },
    { id: "crew", weight: 25, ordinal: 1 },
    { id: "hybrid", weight: 20, ordinal: 2 },
    { id: "pricing", weight: 19, ordinal: 3 },
    { id: "creative", weight: 13, ordinal: 4 },
    { id: "response", weight: 9, ordinal: 5 },
    { id: "dei", weight: 3, ordinal: 6 },
  ]);
  assert.equal(weights.reduce((sum, criterion) => sum + criterion.weight, 0), 100);
  assert.equal(suggestedMandatoryStatus("technical", "Vendor must provide redundant streaming."), "mandatory");
  assert.equal(suggestedMandatoryStatus("technical", "Attendees: 100"), "not_mandatory");
  assert.equal(suggestedVerificationMethod("commercial"), "commercial");
});

test("automatic preparation keeps canonical facts and excludes repeated narrative", () => {
  const duplicates = duplicateRequirementIds([
    { id: "canonical", kind: "technical", normalized_text: "Vendor must provide a complete technical staffing plan.", source_kind: "canonical_proposal", group_key: "production", ordinal: 4 },
    { id: "narrative", kind: "narrative", normalized_text: "Provide a complete technical staffing plan", source_kind: "rendered_rfp", group_key: "production", ordinal: 20 },
  ]);
  assert.deepEqual([...duplicates], ["narrative"]);
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
  assert.match(routes, /requirement-sets\/:setId\/prepare/);
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

test("curation migration and downstream queries exclude non-evaluation requirements", () => {
  const migration = read("migrations/postgres/056_requirement_curation.up.sql");
  const intelligence = read("src/modules/vendorIntelligence/postgresVendorIntelligenceRepository.ts");
  const evaluation = read("src/modules/evaluationEngine/postgresEvaluationEngineRepository.ts");
  const comparison = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  assert.match(migration, /included boolean NOT NULL DEFAULT true/);
  assert.match(migration, /inclusion_reviewed boolean NOT NULL DEFAULT true/);
  assert.match(migration, /inclusion_reviewed SET DEFAULT false/);
  assert.match(intelligence, /requirement_set_id=\$1 AND included=true/);
  assert.match(evaluation, /r\.criterion_id=c\.id AND r\.included=true/);
  assert.match(comparison, /r\.requirement_set_id=\$2 AND r\.included=true/);
});

test("registry active views, replay, and rendered prose are current-epoch only", () => {
  const repository = read("src/modules/requirementRegistry/postgresRequirementRegistryRepository.ts");
  const generator = read("src/modules/requirementRegistry/generator.ts");
  for (const token of [
    "requirement-registry.v3",
    "registryEpochKey",
    "generator_version=$3",
    "s.generator_version=$4",
    "PROPOSAL_DRAFT_INPUT_VERSION",
    "activeProposalWorkflowFingerprintContent",
    "LEGACY_STANDALONE_VIDEO_RECORDING_SECTION_KEY",
  ]) assert.ok(`${repository}\n${generator}`.includes(token), token);
  assert.match(repository, /JOIN rfpilot\.requirement_sets s[\s\S]*s\.generator_version=\$3/);
  assert.match(repository, /proposal_draft_citations retired/);
});

test("planner instructions are generated but start excluded, so vendors are never marked as failing to answer a due date", () => {
  const proposal = {
    event: { attendeeCount: 450, sacredConstraints: "Use the venue's exclusive union labor provider." },
    budget: {
      estimatedAvBudget: "USD 200,000",
      proposalSubmissionDueDate: "2026-09-30",
      vendorQuestionsDueDate: "2026-09-15",
      proposalFormatPreferences: "PDF, under 30 pages",
      competitiveBid: true,
      sustainabilityDeiNotes: "Describe your DEI hiring practices.",
    },
    production: { platformIntegrationWithAv: "Zoom Events" },
  };
  const requirements = generateRequirements(proposal);
  const byTitle = Object.fromEntries(requirements.map((item) => [item.title, item]));
  for (const title of ["Proposal Submission Due Date", "Vendor Questions Due Date", "Proposal Format Preferences", "Competitive Bid", "Estimated AV Budget"]) {
    assert.ok(byTitle[title], `${title} is still generated for traceability`);
    assert.ok(isPlannerInstructionLocator(byTitle[title].sourceLocator), `${title} is flagged as an instruction to vendors`);
  }
  assert.ok(byTitle["Sustainability DEI Notes"] && !isPlannerInstructionLocator(byTitle["Sustainability DEI Notes"].sourceLocator), "a real ask stays a requirement");
  assert.ok(!isPlannerInstructionLocator(byTitle["Attendee Count"].sourceLocator));
  assert.equal(byTitle["Platform Integration With AV"].kind, "technical", "industry acronyms are kept upright in titles");
  assert.equal(isPlannerInstructionLocator(null), false);
  assert.equal(isPlannerInstructionLocator({ kind: "canonical_proposal" }), false);
});

test("each non-negotiable constraint becomes its own requirement, titled by what it says", () => {
  const proposal = { event: { sacredConstraints: "Union labor only at the venue.\nClosed captions on every session; No drones indoors" } };
  const constraints = generateRequirements(proposal).filter((item) => item.kind === "mandatory");
  assert.deepEqual(constraints.map((item) => item.title), [
    "Non-negotiable: Union labor only at the venue.",
    "Non-negotiable: Closed captions on every session",
    "Non-negotiable: No drones indoors",
  ]);
  assert.equal(new Set(constraints.map((item) => item.key)).size, 3, "each constraint has its own stable key");
  assert.ok(constraints.every((item) => item.sourceLocator.path === "/content/event/sacredConstraints"));
  assert.ok(constraints.every((item) => item.importance === "high"));
  const single = generateRequirements({ event: { sacredConstraints: "One rule." } }).filter((item) => item.kind === "mandatory");
  assert.equal(single.length, 1);
  assert.equal(single[0].title, "Non-negotiable: One rule.");
});

test("the registry stores planner instructions as excluded and keeps them excluded on automatic review", () => {
  const repository = read("src/modules/requirementRegistry/postgresRequirementRegistryRepository.ts");
  assert.match(repository, /group_key,ordinal,updated_by_external_user_id,included,inclusion_reviewed/);
  assert.match(repository, /!isPlannerInstructionLocator\(requirement\.sourceLocator\), isPlannerInstructionLocator\(requirement\.sourceLocator\)\]/);
  assert.match(repository, /const included = !duplicateIds\.has\(requirement\.id\) && !isPlannerInstructionLocator\(requirement\.source_locator\)/);
});

test("the requirement-set list counts only included requirements, matching what vendors are judged on", () => {
  const repository = read("src/modules/requirementRegistry/postgresRequirementRegistryRepository.ts");
  // The intelligence home said "Version 4 contains 22 requirements" while the
  // list showed 19 included and 3 left out.
  assert.match(repository, /WHERE r\.requirement_set_id=s\.id AND r\.included=true\n\s+AND \(\$2::boolean OR r\.group_key IS DISTINCT FROM \$3\)\) requirement_count/);
  // The list and the detail view both override that SQL count from the rows they load.
  assert.equal((repository.match(/requirement_count: requirements\.rows\.filter\(\(row: any\) => row\.included\)\.length/g) ?? []).length, 2);
  assert.doesNotMatch(repository, /requirement_count: requirements\.rows\.length/);
});
