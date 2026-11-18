import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { adminOrganizationContentController as controller } from "../controller/adminOrganizationContentController";

/* Mounted at /api/v1. RFPilot staff read a customer organization's content with no grant and no
   action from that organization (owner decision, 2026-11-17; docs/DECISIONS.md). GET only: staff
   do not edit or delete customer content, and account management is a later ticket.

   Guard: authenticate, a staff membership role, and (in the service) an `admins` account holding
   an admin role, so no customer role passes and a `users` account holding a staff role is
   refused. Each read is recorded in the staff organization's audit trail; nothing is written to
   the customer organization. */
const router = Router();

export const staffContentReads = securityRateLimit({
  name: "organization-content-read",
  limit: 300,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

const staff = [authenticate, authorize("admin", "super_admin", "superadmin"), staffContentReads];

router.get("/admin/organizations/:organizationId/proposals", ...staff, controller.proposals);
router.get("/admin/organizations/:organizationId/proposals/:proposalId", ...staff, controller.proposal);
router.get("/admin/organizations/:organizationId/proposals/:proposalId/vendor-responses", ...staff, controller.vendorResponses);
router.get("/admin/organizations/:organizationId/members", ...staff, controller.members);
router.get("/admin/organizations/:organizationId/teams", ...staff, controller.teams);
router.get("/admin/organizations/:organizationId/templates", ...staff, controller.templates);
router.get("/admin/organizations/:organizationId/templates/:templateId", ...staff, controller.template);
router.get("/admin/organizations/:organizationId/vendors", ...staff, controller.vendors);

export default router;
