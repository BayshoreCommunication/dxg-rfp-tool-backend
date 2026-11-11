import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { commercialAccess, createAssignment, createAutomaticEvaluation, createEvaluation, declareConflict, readEvaluation, readLatestEvaluation, recordScore, reopenScore } from "../controller/evaluationEngineController";
import { requirePlanFeature } from "../src/modules/entitlements/http/planGate";

const router = Router(), base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
// Every RFP intelligence action is a plan feature (ORG-601): locked organizations get
// PLAN_FEATURE_LOCKED before any handler runs, so no request can queue an intelligence job for them.
const intelligencePlan = requirePlanFeature("proposalIntelligence");
const reads = securityRateLimit({ name: "evaluation-engine-read", limit: 120, windowMs: 15 * 60_000 });
const writes = securityRateLimit({ name: "evaluation-engine-write", limit: 60, windowMs: 15 * 60_000 });
router.post(`${base}/evaluation-runs`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writes, createEvaluation);
router.post(`${base}/evaluation-runs/automatic`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writes, createAutomaticEvaluation);
router.get(`${base}/evaluation-runs/latest`, authenticate, authorizeAction("proposal:read"), intelligencePlan, reads, readLatestEvaluation);
router.get(`${base}/evaluation-runs/:runId`, authenticate, authorizeAction("proposal:read"), intelligencePlan, reads, readEvaluation);
router.post(`${base}/evaluation-runs/:runId/assignments`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writes, createAssignment);
router.post(`${base}/evaluation-runs/:runId/conflict-declaration`, authenticate, authorizeAction("proposal:read"), intelligencePlan, writes, declareConflict);
router.post(`${base}/evaluation-runs/:runId/score-events`, authenticate, authorizeAction("proposal:read"), intelligencePlan, writes, recordScore);
router.post(`${base}/evaluation-runs/:runId/score-events/reopen`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writes, reopenScore);
router.post(`${base}/evaluation-runs/:runId/commercial-access-events`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writes, commercialAccess);
export default router;
