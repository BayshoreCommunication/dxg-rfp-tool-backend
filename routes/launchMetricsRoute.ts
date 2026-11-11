import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { launchMetricsController as controller } from "../controller/launchMetricsController";

// ORG-505, mounted at /api/v1. The PRD launch metrics for Organization Accounts, as counts, rates
// and durations across all customer organizations. DXG staff only: the controller also requires
// an `admins` account, so a member holding a staff role is refused.
const router = Router();

const reads = securityRateLimit({
  name: "launch-metrics-read",
  limit: 30,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

// Query: days (1 to 365, default 30) for the invitation and support-access windows.
router.get("/admin/launch-metrics", authenticate, authorize("admin", "super_admin", "superadmin"), reads, controller.getLaunchMetrics);

export default router;
