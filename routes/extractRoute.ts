import { Router } from "express";
import { extractProposal, extractUpload, normalizeScheduleTimes } from "../controller/extractController";
import { authenticate } from "../middleware/auth";

const router = Router();

/* POST /api/extract-proposal — upload a document and extract proposal fields via AI */
router.post("/", authenticate, extractUpload.single("file"), extractProposal);

/* POST /api/extract-proposal/normalize-times — clean up messy time-of-day strings via AI */
router.post("/normalize-times", authenticate, normalizeScheduleTimes);

export default router;
