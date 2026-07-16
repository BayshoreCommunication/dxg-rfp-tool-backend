import { Router } from "express";
import { issuePublicAccess, revokePublicAccess } from "../controller/publicAccessController";
import { authenticate, authorizeAction } from "../middleware/auth";
const router = Router();
router.post("/", authenticate, authorizeAction("proposal:publish"), issuePublicAccess);
router.delete("/:id", authenticate, authorizeAction("proposal:publish"), revokePublicAccess);
export default router;
