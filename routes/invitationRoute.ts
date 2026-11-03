import { Router, type Request } from "express";
import { createInvitationController } from "../controller/invitationController";
import { authenticate, type AuthRequest } from "../middleware/auth";
import { emailAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

// Sending runs after authenticate, so the limits key on who is sending and for which organization.
const actorIdentity = (req: Request) => `user:${(req as AuthRequest).rfpActor?.userId ?? req.ip}`;
const organizationIdentity = (req: Request) => `organization:${(req as AuthRequest).rfpActor?.organizationId ?? req.ip}`;

export const createInvitationRouter = (controller = createInvitationController()) => {
  const router = Router();
  const lookupLimit = securityRateLimit({ name: "invitation-lookup", limit: 30, windowMs: 15 * 60_000 });
  const acceptLimit = securityRateLimit({ name: "invitation-accept", limit: 10, windowMs: 15 * 60_000, identity: emailAndIpIdentity });
  // Requests, not recipients: the daily per-organization email cap and the resend cooldown live
  // in the service (docs/API.md).
  const sendPerActor = securityRateLimit({ name: "invitation-send-actor", limit: 30, windowMs: 15 * 60_000, identity: actorIdentity });
  const sendPerOrganization = securityRateLimit({ name: "invitation-send-organization", limit: 60, windowMs: 15 * 60_000, identity: organizationIdentity });
  const send = [sendPerActor, sendPerOrganization];

  // Managed by Owners and Admins, and by Team Managers for their own teams when the organization allows it.
  router.get("/organization/invitations", authenticate, controller.list);
  router.post("/organization/invitations", authenticate, ...send, controller.create);
  router.post("/organization/invitations/bulk", authenticate, ...send, controller.createBulk);
  router.post("/organization/invitations/:id/resend", authenticate, ...send, controller.resend);
  router.post("/organization/invitations/:id/revoke", authenticate, controller.revoke);

  // The accept page (dashboard /invite/[token]). Public: the token is the credential.
  router.post("/invitations/lookup", lookupLimit, controller.lookup);
  router.post("/invitations/accept", acceptLimit, controller.acceptWithExistingAccount);
  router.post("/invitations/accept/register", acceptLimit, controller.acceptWithNewAccount);
  // For accounts with no usable password (created by Google sign-in) and Google sign-up.
  router.post("/invitations/accept/google", acceptLimit, controller.acceptWithGoogle);
  return router;
};

export default createInvitationRouter();
