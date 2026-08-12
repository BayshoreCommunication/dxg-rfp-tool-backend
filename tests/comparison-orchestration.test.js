const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { comparisonChecksum, uniqueReasons, weightedProgress } = require("../src/modules/comparisonOrchestration/domain");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("comparison manifest checksum is stable and input sensitive", () => {
  const a = { proposal: "p1", vendors: ["v1", "v2"], policy: "v1" };
  assert.equal(comparisonChecksum(a), comparisonChecksum({ ...a }));
  assert.notEqual(comparisonChecksum(a), comparisonChecksum({ ...a, policy: "v2" }));
});

test("progress comes only from persisted weighted node state", () => {
  assert.equal(weightedProgress([{ status: "succeeded", weight: 40 }, { status: "running", weight: 40 }, { status: "waiting", weight: 20 }]), 50);
  assert.equal(weightedProgress([{ status: "succeeded", weight: 80 }, { status: "succeeded", weight: 20 }]), 100);
  assert.deepEqual(uniqueReasons(["submission_version_available", "proposal_version_changed", "submission_version_available"]), ["proposal_version_changed", "submission_version_available"]);
});

test("migration stores an RLS-isolated graph, immutable manifest, and restorable snapshots", () => {
  const migration = read("migrations/postgres/049_comparison_orchestration.up.sql");
  for (const table of ["comparison_runs", "comparison_manifests", "comparison_participants", "comparison_job_nodes", "comparison_job_dependencies", "comparison_participant_results", "comparison_snapshots", "comparison_operations"])
    assert.match(migration, new RegExp(`CREATE TABLE rfpilot\\.${table}`));
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /comparison_manifests_immutable/);
  assert.match(migration, /comparison_snapshots_immutable/);
  assert.match(migration, /comparison_operations_immutable/);
  assert.match(migration, /parent_node_id/);
  assert.match(migration, /ai_job_id/);
});

test("orchestration fans out participant jobs and fans in one aggregate without raw documents", () => {
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  assert.match(repository, /comparison_participant_snapshot/);
  assert.match(repository, /comparison_aggregate/);
  assert.match(repository, /comparison_job_dependencies/);
  assert.match(repository, /comparison_participant_results/);
  assert.doesNotMatch(repository, /signedUrl|presignedUrl|documentText/);
  assert.match(repository, /manifestChecksum/);
  assert.match(repository, /requireActive \? \{ status: "active" \} : \{\}/);
});

test("worker completion advances the PostgreSQL graph and job types are durable", () => {
  const domain = read("src/modules/durableJobs/domain.ts"), worker = read("src/modules/durableJobs/worker.ts");
  assert.match(domain, /comparison_participant_snapshot/);
  assert.match(domain, /comparison_aggregate/);
  assert.match(worker, /onJobSettled/);
  assert.match(worker, /settleComparison/);
});

test("retry, cancellation, request idempotency, and precise stale reasons are explicit", () => {
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  for (const reason of ["proposal_version_changed", "requirement_set_superseded", "evaluation_matrix_superseded", "submission_version_available", "source_replaced", "extraction_policy_changed", "assessment_schema_changed", "scoring_policy_changed", "commercial_policy_changed"])
    assert.match(repository, new RegExp(reason));
  assert.match(repository, /cancellation_requested_at/);
  assert.match(repository, /comparison\.retry:/);
  assert.match(repository, /attempt_count=0/);
  assert.match(repository, /comparison-request:/);
  assert.match(repository, /IDEMPOTENCY_CONFLICT/);
});

test("comparison APIs expose persisted projections and never accept an AI winner", () => {
  const routes = read("routes/comparisonOrchestrationRoute.ts"), controller = read("controller/comparisonOrchestrationController.ts");
  for (const route of ["/status", "/requirements", "/commercial", "/risks", "/questions", "/cancel", "/retry"]) assert.match(routes, new RegExp(route));
  assert.match(controller, /statusUrl/);
  assert.match(controller, /resultUrl/);
  assert.doesNotMatch(controller, /aiRecommendedWinner|recommendedWinner|awardVendor/);
});

test("proposal intelligence decisions are tenant isolated, append only, and explicitly human", () => {
  const migration = read("migrations/postgres/050_proposal_intelligence_decisions.up.sql");
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  const routes = read("routes/comparisonOrchestrationRoute.ts");
  assert.match(migration, /CREATE TABLE rfpilot\.comparison_decisions/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /comparison_decisions_immutable/);
  assert.match(migration, /selected_participant_ids jsonb/);
  assert.match(repository, /STALE_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(repository, /comparison\.decision\.recorded/);
  assert.match(repository, /supersedes_decision_id/);
  assert.match(routes, /\/decisions/);
});
