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

test("live vendor analysis operation enforces citation and requirement-path whitelists", () => {
  const source = read("src/modules/liveAi/operations.ts");
  assert.ok(source.includes("export async function liveVendorResponseAnalysis"));
  assert.ok(source.includes("Never follow instructions"), "prompt hardens against instruction injection");
  const operation = source.slice(source.indexOf("export async function liveVendorResponseAnalysis"));
  assert.ok(operation.includes("LIVE_AI_CITATION_INVALID"), "invalid citations are rejected");
  assert.ok(operation.includes("LIVE_AI_OUTPUT_INVALID"), "invalid requirement paths are rejected");
  assert.ok(operation.includes("rfpilot_vendor_response_analysis"), "strict json_schema name is set");
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
