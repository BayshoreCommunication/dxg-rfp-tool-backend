import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { rfpSharesController as controller } from "../controller/rfpSharesController";

const router = Router();

// Who may share a given proposal is the access policy's "share" decision, checked per proposal.
router.get("/proposals/:proposalId/shares", authenticate, authorizeAction("proposal:read"), controller.list);
router.put("/proposals/:proposalId/shares/:userId", authenticate, authorizeAction("proposal:write"), controller.grant);
router.delete("/proposals/:proposalId/shares/:userId", authenticate, authorizeAction("proposal:write"), controller.revoke);

export default router;
