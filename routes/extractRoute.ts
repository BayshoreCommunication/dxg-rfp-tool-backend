import { Router } from "express";
import { extractProposal, extractUpload } from "../controller/extractController";
import { authenticate } from "../middleware/auth";

const router = Router();

/* POST /api/extract-proposal — upload a document and extract proposal fields via AI */
router.post("/", authenticate, extractUpload.single("file"), extractProposal);

export default router;
