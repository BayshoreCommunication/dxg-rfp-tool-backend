import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import {
  createVendorIntelligence,
  readLatestVendorIntelligence,
  readVendorIntelligence,
  reviewVendorIntelligence,
} from "../controller/vendorIntelligenceController";

const router = Router();
const base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
const readLimit = securityRateLimit({ name: "vendor-intelligence-read", limit: 120, windowMs: 15 * 60_000 });
const writeLimit = securityRateLimit({ name: "vendor-intelligence-write", limit: 30, windowMs: 15 * 60_000 });

router.post(`${base}/fact-mapping-jobs`, authenticate, authorizeAction("proposal:write"), writeLimit, createVendorIntelligence);
router.get(`${base}/fact-mapping-runs/latest`, authenticate, authorizeAction("proposal:read"), readLimit, readLatestVendorIntelligence);
router.get(`${base}/fact-mapping-runs/:runId`, authenticate, authorizeAction("proposal:read"), readLimit, readVendorIntelligence);
router.post(`${base}/fact-mapping-runs/:runId/reviews`, authenticate, authorizeAction("proposal:write"), writeLimit, reviewVendorIntelligence);

export default router;
