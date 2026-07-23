import type { NextFunction, Response } from "express";
import { Router } from "express";
import {
  changeExpertRuleStatus,
  changePricingRecordStatus,
  createExpertRule,
  createPricingRecord,
  deletePricingRecord,
  listExpertRules,
  listPricingRecords,
  updateExpertRule,
  updatePricingRecord,
} from "../controller/pricingController";
import type { AuthRequest } from "../middleware/auth";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router = Router();
const mutate = securityRateLimit({ name: "pricing-admin", limit: 120, windowMs: 15 * 60_000 });
const read = authorizeAction("knowledge:read");
const write = authorizeAction("knowledge:write");
const approve = authorizeAction("knowledge:approve");

// Status changes branch on the requested target state: promoting content into
// the approved/active corpus requires knowledge:approve, while retiring only
// needs knowledge:write. Unknown statuses fall to the stricter approve gate
// and are then rejected by input validation in the controller.
const bodyStatus = (req: AuthRequest) => String((req.body as { status?: unknown } | undefined)?.status ?? "");
const recordStatusAuthorization = (req: AuthRequest, res: Response, next: NextFunction) =>
  (["draft", "retired"].includes(bodyStatus(req)) ? write : approve)(req, res, next);
const ruleStatusAuthorization = (req: AuthRequest, res: Response, next: NextFunction) =>
  (bodyStatus(req) === "retired" ? write : approve)(req, res, next);

router.get("/knowledge/pricing-records", authenticate, read, listPricingRecords);
router.post("/knowledge/pricing-records", authenticate, write, mutate, createPricingRecord);
router.put("/knowledge/pricing-records/:recordId", authenticate, write, mutate, updatePricingRecord);
router.post("/knowledge/pricing-records/:recordId/status", authenticate, recordStatusAuthorization, mutate, changePricingRecordStatus);
router.delete("/knowledge/pricing-records/:recordId", authenticate, write, mutate, deletePricingRecord);

router.get("/knowledge/expert-rules", authenticate, read, listExpertRules);
router.post("/knowledge/expert-rules", authenticate, write, mutate, createExpertRule);
router.put("/knowledge/expert-rules/:ruleId", authenticate, write, mutate, updateExpertRule);
router.post("/knowledge/expert-rules/:ruleId/status", authenticate, ruleStatusAuthorization, mutate, changeExpertRuleStatus);

export default router;
