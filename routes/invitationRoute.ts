import { Router } from "express";
import { createInvitationController } from "../controller/invitationController";
import { authenticate } from "../middleware/auth";
import { emailAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

export const createInvitationRouter = (controller = createInvitationController()) => {
  const router = Router();
  const lookupLimit = securityRateLimit({ name: "invitation-lookup", limit: 30, windowMs: 15 * 60_000 });
  const acceptLimit = securityRateLimit({ name: "invitation-accept", limit: 10, windowMs: 15 * 60_000, identity: emailAndIpIdentity });

  // Managed by Owners and Admins, and by Team Managers for their own teams when the organization allows it.
  router.get("/organization/invitations", authenticate, controller.list);
  router.post("/organization/invitations", authenticate, controller.create);
  router.post("/organization/invitations/bulk", authenticate, controller.createBulk);
  router.post("/organization/invitations/:id/resend", authenticate, controller.resend);
  router.post("/organization/invitations/:id/revoke", authenticate, controller.revoke);

  // The accept page (dashboard /invite/[token]). Public: the token is the credential.
  router.post("/invitations/lookup", lookupLimit, controller.lookup);
  router.post("/invitations/accept", acceptLimit, controller.acceptWithExistingAccount);
  router.post("/invitations/accept/register", acceptLimit, controller.acceptWithNewAccount);
  return router;
};

export default createInvitationRouter();
