import { Router } from "express";
import { extractProposal, extractUpload, normalizeTimes } from "../controller/extractController";
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

router.post(
  "/normalize-times",
  authenticate,
  authorizeAction("proposal:write"),
  securityRateLimit({ name: "normalize-times", limit: 60, windowMs: 15 * 60_000 }),
  normalizeTimes,
);

export default router;
