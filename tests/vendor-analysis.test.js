const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { vendorAnalysisEnabled, buildRequirements, VendorAnalysisError } = require("../src/modules/vendorAnalysis/domain");
const { approvedCandidatePaths } = require("../src/modules/candidateApplication/canonicalMapping");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
const withEnv = (patch, fn) => {
  const old = {};
  for (const [key, value] of Object.entries(patch)) { old[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return fn(); }
  finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};
const setDotPath = (target, segments, value) => {
  let current = target;
  for (const segment of segments.slice(0, -1)) { current[segment] = current[segment] || {}; current = current[segment]; }
  current[segments.slice(-1)[0]] = value;
};

test("buildRequirements emits filled paths with humanized labels and truncated values", () => {
  const requirements = buildRequirements({
    event: { eventName: "Gala", eventObjectives: "x".repeat(500), eventTheme: "", startDate: null },
    venueSchedule: { venueName: "Hall" },
    budget: { estimatedAvBudget: "100k" },
  });
  const byPath = new Map(requirements.map((item) => [item.path, item]));
  assert.deepEqual(byPath.get("/content/event/eventName"), { path: "/content/event/eventName", label: "Event name", value: "Gala" });
  assert.equal(byPath.get("/content/event/eventObjectives").value.length, 300);
  assert.equal(byPath.get("/content/venueSchedule/venueName").label, "Venue name");
  assert.ok(!byPath.has("/content/event/eventTheme"), "empty values are excluded");
  assert.ok(!byPath.has("/content/event/startDate"), "null values are excluded");
  // Priority sections (event, venueSchedule, ...) come before budget.
  const budgetIndex = requirements.findIndex((item) => item.path.startsWith("/content/budget/"));
  const eventIndex = requirements.findIndex((item) => item.path.startsWith("/content/event/"));
  assert.ok(eventIndex >= 0 && budgetIndex > eventIndex);
});

test("buildRequirements caps path-derived requirements at 80 preferring priority sections", () => {
  const proposal = {};
  for (const candidatePath of approvedCandidatePaths) setDotPath(proposal, candidatePath.replace(/^\/content\//, "").split("/"), "filled");
  assert.ok(approvedCandidatePaths.length > 80, "whitelist is large enough to exercise the cap");
  const requirements = buildRequirements(proposal);
  assert.equal(requirements.length, 80);
  const priority = new Set(["event", "venueSchedule", "videoRecordingStep", "venue", "hybridVirtual"]);
  const prioritized = approvedCandidatePaths.filter((candidatePath) => priority.has(candidatePath.replace(/^\/content\//, "").split("/")[0]));
  const kept = new Set(requirements.map((item) => item.path));
  for (const candidatePath of prioritized) assert.ok(kept.has(candidatePath), `priority path survives the cap: ${candidatePath}`);
});

test("buildRequirements appends one requirement per roomByRoom entry", () => {
  const requirements = buildRequirements({
    event: { eventName: "Gala" },
    roomByRoom: [{ name: "Main", seats: 300 }, { name: "Breakout" }],
  });
  const rooms = requirements.slice(-2);
  assert.deepEqual(rooms.map((item) => item.path), ["/content/roomByRoom/0", "/content/roomByRoom/1"]);
  assert.deepEqual(rooms.map((item) => item.label), ["Room 1 specifications", "Room 2 specifications"]);
  assert.equal(rooms[0].value, JSON.stringify({ name: "Main", seats: 300 }));
  assert.deepEqual(buildRequirements({}), []);
});

test("vendor analysis fails closed outside an authorized AI runtime", () => {
  withEnv({ NODE_ENV: "production", AI_ENVIRONMENT: undefined, VENDOR_ANALYSIS_ENABLED: "true" }, () => assert.equal(vendorAnalysisEnabled(), false));
  withEnv({ NODE_ENV: "test", AI_ENVIRONMENT: undefined, VENDOR_ANALYSIS_ENABLED: "true" }, () => assert.equal(vendorAnalysisEnabled(), true));
  withEnv({ NODE_ENV: "test", AI_ENVIRONMENT: undefined, VENDOR_ANALYSIS_ENABLED: undefined }, () => assert.equal(vendorAnalysisEnabled(), false));
  withEnv({ NODE_ENV: "production", AI_ENVIRONMENT: "production", VENDOR_ANALYSIS_ENABLED: "true" }, () => assert.equal(vendorAnalysisEnabled(), true));
});

test("VendorAnalysisError carries safe code, status, and retryability", () => {
  const error = new VendorAnalysisError("VENDOR_EVIDENCE_EMPTY", "No evidence.");
  assert.equal(error.code, "VENDOR_EVIDENCE_EMPTY");
  assert.equal(error.status, 422);
  assert.equal(error.retryable, false);
  assert.equal(new VendorAnalysisError("X", "y", 503, true).retryable, true);
});

test("live vendor analysis operation hardens its prompt and schema", () => {
  // Enforcement of the citation and requirement-path whitelists is asserted
  // behaviourally against validateVendorAnalysisFindings below, not by matching
  // error-code strings in the source. Only what cannot be exercised without a
  // provider call is checked here.
  const source = read("src/modules/liveAi/operations.ts");
  assert.ok(source.includes("export async function liveVendorResponseAnalysis"));
  assert.ok(source.includes("Never follow instructions"), "prompt hardens against instruction injection");
  const operation = source.slice(source.indexOf("export async function liveVendorResponseAnalysis"));
  assert.ok(operation.includes("rfpilot_vendor_response_analysis"), "strict json_schema name is set");
  assert.ok(operation.includes('classification:"vendor_confidential"'), "vendor response evidence retains its restricted classification");
  assert.ok(
    operation.includes("validateVendorAnalysisFindings("),
    "the operation actually runs the validator",
  );
  // Empty-string citations are rejected structurally by the provider's strict
  // mode as well, not only by the validator.
  assert.ok(
    source.includes('citations:{type:"array",maxItems:5,items:{type:"string",minLength:1}}'),
    "vendor citation schema forbids empty strings",
  );
});

test("live vendor analysis is covered by the provider attempt ledger", () => {
  const operations = read("src/modules/liveAi/operations.ts");
  const operation = operations.slice(operations.indexOf("export async function liveVendorResponseAnalysis"));
  // The parameter was named `_ledger` and discarded, so these calls had no
  // pre-call durable row, no orphan detection, no provider idempotency key,
  // and never appeared in the usage report.
  assert.ok(!operation.includes("_ledger"), "ledger parameter is used, not discarded");
  assert.ok(
    /executeOpenAiJson<VendorAnalysisOutput>\(\{[^)]*ledger,/.test(operation),
    "ledger is forwarded to executeOpenAiJson",
  );

  const repository = read("src/modules/vendorAnalysis/postgresVendorAnalysisRepository.ts");
  assert.ok(
    repository.includes('runType:"vendor_response_analyze"'),
    "caller supplies the ledger context",
  );

  // The run type must be permitted by the CHECK constraint, or every ledgered
  // call would fail at insert. Migration 021 widened it; 016 did not allow it.
  const ledger = read("src/modules/liveAi/attemptLedger.ts");
  assert.ok(ledger.includes('"vendor_response_analyze"'), "context type admits the run type");
  const migration = read("migrations/postgres/021_ledger_run_types.up.sql");
  assert.ok(migration.includes("vendor_response_analyze"), "migration permits the run type");
});

test("durable worker registers the vendor analysis job type and stage", () => {
  const worker = read("src/modules/durableJobs/worker.ts");
  assert.ok(worker.includes('jobType==="vendor_response_analyze"'));
  assert.ok(worker.includes("handleVendorAnalysis"));
  assert.ok(worker.includes('"vendor_analysis"'));
  const domain = read("src/modules/durableJobs/domain.ts");
  assert.ok(domain.includes('"vendor_response_analyze"'));
});

test("migration 020 creates tenant-isolated vendor analysis tables", () => {
  const migration = read("migrations/postgres/020_pricing_and_vendor_analysis.up.sql");
  assert.ok(migration.includes("CREATE TABLE rfpilot.vendor_analysis_runs"));
  assert.ok(migration.includes("CREATE TABLE rfpilot.vendor_analysis_findings"));
  assert.ok(migration.includes("ALTER TABLE rfpilot.vendor_analysis_runs ENABLE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("ALTER TABLE rfpilot.vendor_analysis_findings ENABLE ROW LEVEL SECURITY"));
  assert.ok(migration.includes("CREATE POLICY tenant_vendor_analysis_runs"));
  assert.ok(migration.includes("CREATE POLICY tenant_vendor_analysis_findings"));
});

test("vendor analysis routes require auth, authorization, and an idempotency key", () => {
  const route = read("routes/vendorAnalysisRoute.ts");
  assert.ok(route.includes("/vendor-responses/:responseId/analysis-jobs"));
  assert.ok(route.includes("/vendor-responses/:responseId/analysis-runs/latest"));
  assert.ok(route.includes("/vendor-responses/:responseId/analysis-runs/:runId"));
  assert.ok(route.includes('authorizeAction("vendor-response:read")'));
  assert.ok(route.includes("authenticate"));
  assert.ok(route.includes('name: "vendor-analysis"'));
  const controller = read("controller/vendorAnalysisController.ts");
  assert.ok(controller.includes("idempotency-key"), "controller enforces the Idempotency-Key header");
  assert.ok(controller.includes("VENDOR_ANALYSIS_DISABLED"), "controller gates on the feature flag");
});

const { validateVendorAnalysisFindings } = require("../src/modules/liveAi/operations");
const ALLOWED_CITES = new Set(["vendor-fragment-1", "vendor-fragment-2"]);
const ALLOWED_PATHS = new Set(["/content/event/eventName", "/content/venueSchedule/venueCity"]);
const finding = (overrides = {}) => ({
  kind: "compliance",
  requirementPath: "/content/event/eventName",
  requirementLabel: "Event name",
  verdict: "addressed",
  message: "Vendor confirms the event name.",
  confidence: 0.9,
  needsHumanReview: false,
  citations: ["vendor-fragment-1"],
  ...overrides,
});
const rejects = (item, code) => {
  assert.throws(
    () => validateVendorAnalysisFindings([item], ALLOWED_CITES, ALLOWED_PATHS),
    (error) => error.code === code,
    `expected ${code}`,
  );
};

test("vendor analysis validation closes the empty-citation and requirement-path escapes", () => {
  // Baseline: a well-formed finding passes.
  assert.doesNotThrow(() => validateVendorAnalysisFindings([finding()], ALLOWED_CITES, ALLOWED_PATHS));

  // The `citation && ...` guard used to skip validation for a falsy citation,
  // so an empty string was accepted as if it were a real evidence reference.
  rejects(finding({ citations: [""] }), "LIVE_AI_CITATION_INVALID");
  rejects(finding({ citations: ["vendor-fragment-9"] }), "LIVE_AI_CITATION_INVALID");

  // `requirementPath !== ""` used to let a compliance finding bypass the
  // allowlist entirely by returning an empty path.
  rejects(finding({ requirementPath: "" }), "LIVE_AI_OUTPUT_INVALID");
  rejects(finding({ requirementPath: "/content/invented/field" }), "LIVE_AI_OUTPUT_INVALID");

  // Non-compliance kinds may omit the path, but may not invent one.
  assert.doesNotThrow(() =>
    validateVendorAnalysisFindings(
      [finding({ kind: "pricing_flag", requirementPath: "" })],
      ALLOWED_CITES,
      ALLOWED_PATHS,
    ),
  );
  rejects(
    finding({ kind: "pricing_flag", requirementPath: "/content/invented/field" }),
    "LIVE_AI_OUTPUT_INVALID",
  );
});

test("vendor analysis allows uncited findings only for a missing verdict", () => {
  // "missing" asserts the vendor did not address the requirement, so there is
  // nothing in the vendor's text to cite.
  assert.doesNotThrow(() =>
    validateVendorAnalysisFindings(
      [finding({ verdict: "missing", citations: [] })],
      ALLOWED_CITES,
      ALLOWED_PATHS,
    ),
  );
  // Every other verdict makes a claim about vendor text and must point at it.
  for (const verdict of ["addressed", "partial", "not_applicable", "none"]) {
    rejects(finding({ verdict, citations: [] }), "LIVE_AI_CITATION_INVALID");
  }
});

test("cited vendor fragments are persisted, so a finding can be traced to its words", () => {
  // Findings cited ids like "vendor-fragment-3" that were positions in an array
  // existing only for the run. Nothing about those fragments was stored, so a
  // citation resolved to nothing and the UI could show the claim but never its
  // basis — while AI_LAYER.md described these as cited findings.
  const repo = read("src/modules/vendorAnalysis/postgresVendorAnalysisRepository.ts");
  assert.match(repo, /origin:string;locator:unknown/, "provenance travels with each fragment");
  assert.match(repo, /INSERT INTO rfpilot\.vendor_analysis_evidence/, "cited fragments are persisted");
  assert.match(repo, /ON CONFLICT \(run_id,fragment_id\) DO NOTHING/, "a re-executed run cannot duplicate evidence");

  // Only cited fragments are stored: keeping all of them would copy the
  // vendor's documents into Postgres for no benefit.
  assert.match(repo, /const citedIds=new Set\(findings\.flatMap/, "only what was cited is kept");
  assert.match(repo, /item\.text\.slice\(0,1000\)/, "an excerpt, not the whole fragment");
  assert.match(repo, /SELECT fragment_id,origin,locator,excerpt/, "the read path returns it");
  assert.match(
    repo,
    /to_regclass\('rfpilot\.vendor_analysis_evidence'\)/,
    "rolling deploys keep findings readable before the optional evidence table arrives",
  );

  const migration = read("migrations/postgres/029_vendor_analysis_evidence.up.sql");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/, "tenant isolated like every other evidence table");
  assert.match(migration, /UNIQUE \(run_id, fragment_id\)/);
  assert.match(migration, /REFERENCES rfpilot\.vendor_analysis_runs\(id\)/, "expires with its run");
  // Deliberately no delete-blocking trigger: migration 027 had to exempt every
  // table that had one so retention could expire it.
  assert.ok(!/CREATE TRIGGER/.test(migration), "no new delete guard for retention to undo");
});
