import { Router } from "express";
import type { Request } from "express";
import { authenticate, authorize, authorizeAction, type AuthRequest } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { supportAccessController as controller } from "../controller/supportAccessController";
import { staffContentReads } from "./adminOrganizationContentRoute";

// ORG-404, mounted at /api/v1. Since the owner's decision of 2026-11-17 (docs/DECISIONS.md) a
// grant no longer gates anything:
//  - the organization side (Owner/Admin create, list and revoke grants) still answers, because the
//    dashboard released before that decision may still call it. It is to be removed;
//  - the staff side, which the deployed admin app calls, reads WITHOUT a grant, under the same
//    guard and with the same staff-side audit as routes/adminOrganizationContentRoute.ts.
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

// The content reads share the staff content rate limit (per staff member).
const contentGuard = [...agentGuard, staffContentReads];

// One standing entry per organization: every organization's id and name, so it is limited like
// the content reads. The admin app polls it every 30 seconds per open screen (30 requests per
// 15 minutes, 90 at its fastest), which fits inside the shared 300.
router.get("/admin/support-access/grants", ...contentGuard, controller.listGranted);
router.get("/admin/support-access/organizations/:organizationId/rfps", ...contentGuard, controller.listGrantedRfps);
router.get("/admin/support-access/organizations/:organizationId/rfps/:proposalId", ...contentGuard, controller.getGrantedRfp);
router.get("/admin/support-access/organizations/:organizationId/rfps/:proposalId/vendor-responses", ...contentGuard, controller.listGrantedVendorResponses);
// The proposals behind a helpdesk ticket: the requester's, in the ticket's organization.
router.get("/admin/support/tickets/:ticketId/rfps", ...contentGuard, controller.listTicketRfps);

export default router;
