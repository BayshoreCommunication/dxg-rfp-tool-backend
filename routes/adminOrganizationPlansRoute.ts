import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { adminOrganizationPlansController as controller } from "../controller/adminOrganizationPlansController";

// ORG-603, mounted at /api/v1. RFPilot staff (admin-app accounts) view every customer
// organization's plan and RFP usage and change the plan. No customer role passes this guard,
// and the service also requires an `admins` account, so a member holding a staff role is refused.
const router = Router();

const staff = [authenticate, authorize("admin", "super_admin", "superadmin")];
const planWrites = securityRateLimit({
  name: "organization-plan-write",
  limit: 120,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

router.get("/admin/organization-plans", ...staff, controller.list);
router.get("/admin/organization-plans/:organizationId", ...staff, controller.get);
// Body: { plan: "free_trial" | "full_access", note?: string }
router.put("/admin/organization-plans/:organizationId", ...staff, planWrites, controller.change);

export default router;
