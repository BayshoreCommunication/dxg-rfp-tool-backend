const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildVendorRecommendation, comparisonChecksum, evaluatorPanelSignature, freezeScoreInput, uniqueReasons, weightedProgress } = require("../src/modules/comparisonOrchestration/domain");

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

test("score input snapshots are complete, observer-neutral, and content sensitive", () => {
  const rows = [
    { assignmentId: "a", role: "combined", conflictStatus: "clear", criterionId: "technical", eventId: "e1", eventType: "submitted", score: 4, weightedContribution: 20 },
    { assignmentId: "a", role: "combined", conflictStatus: "clear", criterionId: "commercial", eventId: "e2", eventType: "submitted", score: 3, weightedContribution: 30 },
  ];
  const complete = freezeScoreInput(rows);
  const withObserver = freezeScoreInput([...rows, { assignmentId: "observer", role: "observer", conflictStatus: "clear", criterionId: "technical", eventId: "ignored", eventType: "submitted", score: 5, weightedContribution: 25 }]);
  const automated = freezeScoreInput(rows.map((row) => ({ ...row, conflictStatus: "not_applicable" })));
  const changed = freezeScoreInput(rows.map((row) => row.eventId === "e1" ? { ...row, eventId: "e3", eventType: "superseded", score: 2, weightedContribution: 10 } : row));
  const incomplete = freezeScoreInput(rows.map((row) => row.eventId === "e2" ? { ...row, eventId: null, eventType: null, score: null, weightedContribution: null } : row));

  assert.equal(complete.complete, true);
  assert.equal(automated.complete, true);
  assert.equal(withObserver.checksum, complete.checksum);
  assert.notEqual(changed.checksum, complete.checksum);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.reasons.includes("score_missing"));
});

test("evaluator panel signatures are order-independent but detect unfair panel differences", () => {
  const panel = [
    { evaluatorExternalUserId: "reviewer-b", role: "commercial", conflictStatus: "clear", criterionIds: ["pricing"] },
    { evaluatorExternalUserId: "reviewer-a", role: "technical", conflictStatus: "clear", criterionIds: ["technical", "staffing"] },
    { evaluatorExternalUserId: "observer", role: "observer", conflictStatus: "clear", criterionIds: [] },
  ];
  assert.equal(evaluatorPanelSignature(panel), evaluatorPanelSignature([...panel].reverse()));
  assert.notEqual(evaluatorPanelSignature(panel), evaluatorPanelSignature(panel.map((item) => item.evaluatorExternalUserId === "reviewer-a" ? { ...item, criterionIds: ["technical"] } : item)));
});

test("recommendation policy applies eligibility gates, human scores, close-call thresholds, and confidence", () => {
  const clear = buildVendorRecommendation({
    participants: [
      { participantId: "a", vendorLabel: "Alpha", score: 86, evaluatorCount: 3, maxCriterionSpread: 0.5 },
      { participantId: "b", vendorLabel: "Beta", score: 78, evaluatorCount: 3, maxCriterionSpread: 0.5 },
      { participantId: "c", vendorLabel: "Gamma", score: 95, evaluatorCount: 3, maxCriterionSpread: 0.5 },
    ],
    requirements: [
      { participantId: "a", eligibility: false, mandatoryStatus: "mandatory", verdict: "addressed", needsHumanReview: false },
      { participantId: "b", eligibility: false, mandatoryStatus: "mandatory", verdict: "missing", needsHumanReview: false },
      { participantId: "c", eligibility: true, mandatoryStatus: "mandatory", verdict: "missing", needsHumanReview: false },
    ],
    risks: [],
  });
  assert.equal(clear.status, "recommended");
  assert.equal(clear.bestParticipantId, "a");
  assert.equal(clear.confidence, "high");
  assert.equal(clear.ranking.find((item) => item.participantId === "c").eligible, false);

  const close = buildVendorRecommendation({
    participants: [{ participantId: "a", vendorLabel: "Alpha", score: 86, evaluatorCount: 3, maxCriterionSpread: 0.5 }, { participantId: "b", vendorLabel: "Beta", score: 85, evaluatorCount: 3, maxCriterionSpread: 0.5 }],
    requirements: [], risks: [],
  });
  assert.equal(close.status, "close_call");
  assert.equal(close.bestParticipantId, null);
  assert.deepEqual(close.strongestParticipantIds, ["a", "b"]);
  assert.equal(close.confidence, "low");
  assert.deepEqual(close.confidenceReasons, ["close_score_margin"]);
});

test("confidence is low with one evaluator or material evaluator disagreement", () => {
  const single = buildVendorRecommendation({ participants: [{ participantId: "a", vendorLabel: "Alpha", score: 90, evaluatorCount: 1, maxCriterionSpread: 0 }, { participantId: "b", vendorLabel: "Beta", score: 80, evaluatorCount: 1, maxCriterionSpread: 0 }], requirements: [], risks: [] });
  assert.equal(single.confidence, "low");
  assert.ok(single.confidenceReasons.includes("insufficient_independent_evaluators"));
  const disputed = buildVendorRecommendation({ participants: [{ participantId: "a", vendorLabel: "Alpha", score: 90, evaluatorCount: 3, maxCriterionSpread: 2 }, { participantId: "b", vendorLabel: "Beta", score: 80, evaluatorCount: 3, maxCriterionSpread: 1 }], requirements: [], risks: [] });
  assert.equal(disputed.confidence, "low");
  assert.ok(disputed.confidenceReasons.includes("high_evaluator_disagreement"));
});

test("decision acceptance scenarios abstain on ineligible, contradictory, ambiguous, and unresolved evidence", () => {
  const noEligible = buildVendorRecommendation({
    participants: [
      { participantId: "missing", vendorLabel: "Missing Response", score: 99 },
      { participantId: "contradictory", vendorLabel: "Contradictory Response", score: 98 },
    ],
    requirements: [
      { participantId: "missing", eligibility: true, mandatoryStatus: "mandatory", verdict: "missing", needsHumanReview: false },
      { participantId: "contradictory", eligibility: true, mandatoryStatus: "mandatory", verdict: "contradictory", needsHumanReview: false },
    ],
    risks: [],
  });
  assert.equal(noEligible.status, "no_eligible_vendor");
  assert.equal(noEligible.bestParticipantId, null);
  assert.equal(noEligible.confidence, "low");
  assert.ok(noEligible.ranking.every((item) => item.eligible === false && item.rank === null));

  const unresolved = buildVendorRecommendation({
    participants: [
      { participantId: "a", vendorLabel: "Alpha", score: 90 },
      { participantId: "b", vendorLabel: "Beta", score: 82 },
    ],
    requirements: [
      { participantId: "a", eligibility: false, mandatoryStatus: "optional", verdict: "partially_addressed", needsHumanReview: true },
      { participantId: "b", eligibility: false, mandatoryStatus: "optional", verdict: "addressed", needsHumanReview: false },
    ],
    risks: [],
  });
  assert.equal(unresolved.bestParticipantId, "a");
  assert.equal(unresolved.confidence, "low");
  assert.equal(unresolved.ranking[0].unresolvedReviews, 1);
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
  assert.match(repository, /VendorSubmission\.find\(/);
  assert.match(repository, /VendorSubmissionVersion\.find\(/);
  assert.doesNotMatch(repository, /for \(const item of selected\) \{[\s\S]{0,300}VendorSubmission\.findOne/);
});

test("participant score summaries average each criterion and exclude non-scoring assignments", () => {
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  assert.match(repository, /avg\(e\.weighted_contribution\) mean_contribution/);
  assert.match(repository, /role<>'observer'/);
  assert.match(repository, /conflict_status IN\('clear','not_applicable'\)/);
  assert.doesNotMatch(repository, /coalesce\(sum\(weighted_contribution\) FILTER/);
  assert.match(repository, /criterion_scores/);
  assert.match(repository, /avg\(e\.score\) mean_score/);
  assert.match(repository, /max\(e\.criterion_weight\) original_weight/);
});

test("participant score summaries record who set each criterion score and why", () => {
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  const { AUTOMATED_SCORING_POLICY_VERSION, automatedScoringPolicyPattern } = require("../src/modules/evaluationEngine/domain");
  // Origin is read off the scoring policy version the evaluation engine stamps
  // on every automated event, never guessed from the actor or the rationale.
  assert.match(repository, /\(s\.scoring_policy_version LIKE \$2\) automated/);
  assert.match(repository, /count\(\*\) FILTER \(WHERE e\.automated\)::int automated_count/);
  assert.match(repository, /count\(\*\) FILTER \(WHERE NOT e\.automated\)::int human_count/);
  // A person's rationale wins over RFPilot's when both exist for a criterion.
  assert.match(repository, /array_agg\(e\.rationale ORDER BY e\.automated,e\.rationale\)/);
  assert.match(repository, /'automatedCount',automated_count,'humanCount',human_count,'rationale',coalesce\(rationale,''\)/);
  assert.match(repository, /automatedCount: Number\(criterion\.automatedCount \?\? 0\)/);
  const pattern = automatedScoringPolicyPattern();
  assert.equal(pattern, "evidence-derived-rubric-score%");
  assert.ok(AUTOMATED_SCORING_POLICY_VERSION.startsWith(pattern.slice(0, -1)));
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
  for (const reason of ["proposal_version_changed", "requirement_set_superseded", "evaluation_matrix_superseded", "submission_version_available", "source_replaced", "evidence_review_changed", "evaluator_scores_changed", "evaluation_incomplete", "extraction_policy_changed", "assessment_schema_changed", "risk_policy_changed", "scoring_policy_changed", "commercial_policy_changed", "comparison_schema_changed", "recommendation_policy_changed"])
    assert.match(repository, new RegExp(reason));
  assert.match(repository, /cancellation_requested_at/);
  assert.match(repository, /comparison\.retry:/);
  assert.match(repository, /attempt_count=0/);
  assert.match(repository, /comparison-request:/);
  assert.match(repository, /comparisonChecksum\(input\.idempotencyKey\)/);
  assert.match(repository, /REQUIREMENT_GENERATOR_VERSION/);
  assert.match(repository, /IDEMPOTENCY_CONFLICT/);
});

test("comparison identity ignores dormant roots and bookkeeping but preserves room recording", () => {
  const { activeProposalWorkflowFingerprintContent } = require("../src/modules/proposals/domain/workflowSections");
  const base = { __v: 1, version: 4, updatedAt: "old", event: { eventName: "Summit" }, roomByRoom: [{ videoRecording: { videoRecording: "No" } }], videoRecordingStep: { numberOfCameras: "2" } };
  const hiddenOnly = { ...base, __v: 2, version: 5, updatedAt: "new", candidateApplicationIds: ["legacy"], videoRecordingStep: { numberOfCameras: "99" } };
  assert.equal(comparisonChecksum(activeProposalWorkflowFingerprintContent(base)), comparisonChecksum(activeProposalWorkflowFingerprintContent(hiddenOnly)));
  const roomChanged = { ...hiddenOnly, roomByRoom: [{ videoRecording: { videoRecording: "Yes" } }] };
  assert.notEqual(comparisonChecksum(activeProposalWorkflowFingerprintContent(base)), comparisonChecksum(activeProposalWorkflowFingerprintContent(roomChanged)));
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
  assert.match(repository, /stale_reasons[\s\S]{0,240}evaluation_incomplete[\s\S]{0,240}COMPARISON_EVALUATION_INCOMPLETE/);
  assert.match(repository, /comparison\.decision\.recorded/);
  assert.match(repository, /supersedes_decision_id/);
  assert.match(routes, /\/decisions/);
});

test("comparison creation requires human disposition of critical requirement mappings", () => {
  const repository = read("src/modules/comparisonOrchestration/postgresComparisonOrchestrationRepository.ts");
  assert.match(repository, /criticalReviewState/);
  assert.match(repository, /COMPARISON_CRITICAL_REVIEW_INCOMPLETE/);
  assert.match(repository, /r\.included=true AND \(r\.mandatory_status='mandatory' OR r\.eligibility=true\)/);
  assert.match(repository, /f\.contradiction_group IS NOT NULL/);
});
