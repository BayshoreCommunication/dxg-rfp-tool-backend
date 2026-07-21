import { Router } from "express";
import { extractProposal, extractUpload } from "../controller/extractController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();

/* POST /api/extract-proposal — upload a document and extract proposal fields via AI.
   Governed like the /api/v1 AI surface: action authorization + rate limit. */
router.post(
  "/",
  authenticate,
  authorizeAction("proposal:write"),
  securityRateLimit({ name: "extract-proposal", limit: 20, windowMs: 15 * 60_000 }),
  extractUpload.single("file"),
  extractProposal,
);

export default router;
