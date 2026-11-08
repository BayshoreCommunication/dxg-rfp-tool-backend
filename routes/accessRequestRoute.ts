import { Router } from "express";
import { createAccessRequestController } from "../controller/accessRequestController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { emailAndIpIdentity, securityRateLimit } from "../middleware/securityRateLimit";

// ORG-306 domain-match access requests. Mounted at /api.
export const createAccessRequestRouter = (controller = createAccessRequestController()) => {
  const router = Router();
  const requestLimit = securityRateLimit({ name: "access-request-create", limit: 5, windowMs: 15 * 60_000, identity: emailAndIpIdentity });
  const manage = authorizeAction("organization:manage");

  // Signup: after the signup code, instead of creating a separate organization.
  router.post("/auth/access-requests", requestLimit, controller.request);

  // Owners and Admins of the organization the request is for.
  router.get("/v1/organization/access-requests/settings", authenticate, manage, controller.settings);
  router.put("/v1/organization/access-requests/settings", authenticate, manage, controller.updateSettings);
  router.get("/v1/organization/access-requests", authenticate, manage, controller.list);
  router.post("/v1/organization/access-requests/:id/approve", authenticate, manage, controller.approve);
  router.post("/v1/organization/access-requests/:id/deny", authenticate, manage, controller.deny);
  return router;
};

export default createAccessRequestRouter();
