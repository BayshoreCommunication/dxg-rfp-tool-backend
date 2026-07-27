import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import {
  createVendorAnalysis,
  exportVendorAnalysis,
  latestVendorAnalysis,
  readVendorAnalysis,
} from "../controller/vendorAnalysisController";

const router = Router();
const limit = securityRateLimit({
  name: "vendor-analysis",
  limit: 20,
  windowMs: 15 * 60_000,
});

router.post(
  "/vendor-responses/:responseId/analysis-jobs",
  authenticate,
  authorizeAction("vendor-response:read"),
  limit,
  createVendorAnalysis,
);
router.get(
  "/vendor-responses/:responseId/analysis-runs/latest",
  authenticate,
  authorizeAction("vendor-response:read"),
  latestVendorAnalysis,
);
// Registered before the :runId route so "export" is not read as a run id.
router.get(
  "/vendor-responses/:responseId/analysis-export",
  authenticate,
  authorizeAction("vendor-response:read"),
  limit,
  exportVendorAnalysis,
);
router.get(
  "/vendor-responses/:responseId/analysis-runs/:runId",
  authenticate,
  authorizeAction("vendor-response:read"),
  readVendorAnalysis,
);

export default router;
