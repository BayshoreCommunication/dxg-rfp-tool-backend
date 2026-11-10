import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { createEvidenceExtraction, readEvidenceExtractions } from "../controller/evidenceExtractionController";
import { requirePlanFeature } from "../src/modules/entitlements/http/planGate";

const router = Router();
// Every RFP intelligence action is a plan feature (ORG-601): locked organizations get
// PLAN_FEATURE_LOCKED before any handler runs, so no request can queue an intelligence job for them.
const intelligencePlan = requirePlanFeature("proposalIntelligence");
const base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
const readLimit = securityRateLimit({ name: "evidence-extraction-read", limit: 120, windowMs: 15 * 60_000 });
const writeLimit = securityRateLimit({ name: "evidence-extraction-write", limit: 20, windowMs: 15 * 60_000 });

router.post(`${base}/extraction-jobs`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, createEvidenceExtraction);
router.get(`${base}/extractions`, authenticate, authorizeAction("proposal:read"), intelligencePlan, readLimit, readEvidenceExtractions);

export default router;

