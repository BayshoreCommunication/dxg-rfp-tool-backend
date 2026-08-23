import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { commercialAccess, createAssignment, createAutomaticEvaluation, createEvaluation, declareConflict, readEvaluation, readLatestEvaluation, recordScore, reopenScore } from "../controller/evaluationEngineController";

const router = Router(), base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
const reads = securityRateLimit({ name: "evaluation-engine-read", limit: 120, windowMs: 15 * 60_000 });
const writes = securityRateLimit({ name: "evaluation-engine-write", limit: 60, windowMs: 15 * 60_000 });
router.post(`${base}/evaluation-runs`, authenticate, authorizeAction("proposal:write"), writes, createEvaluation);
router.post(`${base}/evaluation-runs/automatic`, authenticate, authorizeAction("proposal:write"), writes, createAutomaticEvaluation);
router.get(`${base}/evaluation-runs/latest`, authenticate, authorizeAction("proposal:read"), reads, readLatestEvaluation);
router.get(`${base}/evaluation-runs/:runId`, authenticate, authorizeAction("proposal:read"), reads, readEvaluation);
router.post(`${base}/evaluation-runs/:runId/assignments`, authenticate, authorizeAction("proposal:write"), writes, createAssignment);
router.post(`${base}/evaluation-runs/:runId/conflict-declaration`, authenticate, authorizeAction("proposal:read"), writes, declareConflict);
router.post(`${base}/evaluation-runs/:runId/score-events`, authenticate, authorizeAction("proposal:read"), writes, recordScore);
router.post(`${base}/evaluation-runs/:runId/score-events/reopen`, authenticate, authorizeAction("proposal:write"), writes, reopenScore);
router.post(`${base}/evaluation-runs/:runId/commercial-access-events`, authenticate, authorizeAction("proposal:write"), writes, commercialAccess);
export default router;
