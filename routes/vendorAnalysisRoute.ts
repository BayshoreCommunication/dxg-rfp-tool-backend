import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import {
  createVendorAnalysis,
  exportVendorAnalysis,
  latestVendorAnalysis,
  readVendorAnalysis,
} from "../controller/vendorAnalysisController";
import { requirePlanFeature } from "../src/modules/entitlements/http/planGate";

const router = Router();
// Analysis reads a vendor response and runs an intelligence job, so it needs both plan
// features (ORG-601).
const analysisPlan = requirePlanFeature("vendorResponses", "proposalIntelligence");
const limit = securityRateLimit({
  name: "vendor-analysis",
  limit: 20,
  windowMs: 15 * 60_000,
});

router.post(
  "/vendor-responses/:responseId/analysis-jobs",
  authenticate,
  authorizeAction("vendor-response:read"), analysisPlan,
  limit,
  createVendorAnalysis,
);
router.get(
  "/vendor-responses/:responseId/analysis-runs/latest",
  authenticate,
  authorizeAction("vendor-response:read"), analysisPlan,
  latestVendorAnalysis,
);
// Registered before the :runId route so "export" is not read as a run id.
router.get(
  "/vendor-responses/:responseId/analysis-export",
  authenticate,
  authorizeAction("vendor-response:read"), analysisPlan,
  limit,
  exportVendorAnalysis,
);
router.get(
  "/vendor-responses/:responseId/analysis-runs/:runId",
  authenticate,
  authorizeAction("vendor-response:read"), analysisPlan,
  readVendorAnalysis,
);

export default router;
