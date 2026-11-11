import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import {
  createVendorIntelligence,
  readLatestVendorIntelligence,
  readVendorIntelligence,
  reviewVendorIntelligence,
} from "../controller/vendorIntelligenceController";
import { requirePlanFeature } from "../src/modules/entitlements/http/planGate";

const router = Router();
// Every RFP intelligence action is a plan feature (ORG-601): locked organizations get
// PLAN_FEATURE_LOCKED before any handler runs, so no request can queue an intelligence job for them.
const intelligencePlan = requirePlanFeature("proposalIntelligence");
const base = "/proposals/:proposalId/intelligence/submissions/:submissionId/versions/:versionId";
const readLimit = securityRateLimit({ name: "vendor-intelligence-read", limit: 120, windowMs: 15 * 60_000 });
const writeLimit = securityRateLimit({ name: "vendor-intelligence-write", limit: 30, windowMs: 15 * 60_000 });

router.post(`${base}/fact-mapping-jobs`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, createVendorIntelligence);
router.get(`${base}/fact-mapping-runs/latest`, authenticate, authorizeAction("proposal:read"), intelligencePlan, readLimit, readLatestVendorIntelligence);
router.get(`${base}/fact-mapping-runs/:runId`, authenticate, authorizeAction("proposal:read"), intelligencePlan, readLimit, readVendorIntelligence);
router.post(`${base}/fact-mapping-runs/:runId/reviews`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, reviewVendorIntelligence);

export default router;
