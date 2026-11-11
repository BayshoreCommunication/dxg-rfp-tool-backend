import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, authorizeAction, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { supportAccessController as controller } from "../controller/supportAccessController";

// ORG-404, mounted at /api/v1. Two sides of one boundary:
//  - an organization's Owner/Admin grants RFPilot Support time-limited read access and revokes it;
//  - RFPilot Support (admin-app accounts) reads a customer organization's RFP data only under an
//    active grant, and every read is audited in that organization.
const router = Router();

const manage = [authenticate, authorizeAction("organization:manage")];
const grantWrites = securityRateLimit({
  name: "support-grant-write",
  limit: 30,
  windowMs: 15 * 60_000,
  identity: (req: Request) => (req as AuthRequest).user?.userId || req.ip || "unknown",
});

router.get("/organization/support-grants", ...manage, controller.listGrants);
router.post("/organization/support-grants", ...manage, grantWrites, controller.createGrant);
router.get("/organization/support-grants/:grantId", ...manage, controller.getGrant);
router.post("/organization/support-grants/:grantId/revoke", ...manage, grantWrites, controller.revokeGrant);

// The service also requires an `admins` account, so a member holding a staff role is refused.
const agentGuard = [authenticate, authorize("admin", "super_admin", "superadmin")];

router.get("/admin/support-access/grants", ...agentGuard, controller.listGranted);
router.get("/admin/support-access/organizations/:organizationId/rfps", ...agentGuard, controller.listGrantedRfps);
router.get("/admin/support-access/organizations/:organizationId/rfps/:proposalId", ...agentGuard, controller.getGrantedRfp);
router.get("/admin/support-access/organizations/:organizationId/rfps/:proposalId/vendor-responses", ...agentGuard, controller.listGrantedVendorResponses);
// The helpdesk ticket itself needs no grant (routes/supportDeskRoute.ts); the RFPs behind it do.
router.get("/admin/support/tickets/:ticketId/rfps", ...agentGuard, controller.listTicketRfps);

export default router;
