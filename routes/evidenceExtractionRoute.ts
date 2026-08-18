import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { createEvidenceExtraction, readEvidenceExtractions } from "../controller/evidenceExtractionController";

const router = Router();
const base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
const readLimit = securityRateLimit({ name: "evidence-extraction-read", limit: 120, windowMs: 15 * 60_000 });
const writeLimit = securityRateLimit({ name: "evidence-extraction-write", limit: 20, windowMs: 15 * 60_000 });

router.post(`${base}/extraction-jobs`, authenticate, authorizeAction("proposal:write"), writeLimit, createEvidenceExtraction);
router.get(`${base}/extractions`, authenticate, authorizeAction("proposal:read"), readLimit, readEvidenceExtractions);

export default router;

