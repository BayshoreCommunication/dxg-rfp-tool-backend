import { Router } from "express";
import {
  approveRequirementSet,
  createRequirementSet,
  listRequirementSets,
  prepareRequirementSet,
  readRequirementSet,
  supersedeRequirementSet,
  updateRequirement,
} from "../controller/requirementRegistryController";
import { authenticate, authorizeAction } from "../middleware/auth";
import { securityRateLimit } from "../middleware/securityRateLimit";
import { requirePlanFeature } from "../src/modules/entitlements/http/planGate";

const router = Router();
// Every RFP intelligence action is a plan feature (ORG-601): locked organizations get
// PLAN_FEATURE_LOCKED before any handler runs, so no request can queue an intelligence job for them.
const intelligencePlan = requirePlanFeature("proposalIntelligence");
const writeLimit = securityRateLimit({ name: "requirement-registry", limit: 60, windowMs: 15 * 60_000 });
const base = "/proposals/:proposalId/intelligence";

router.get(`${base}/requirement-sets`, authenticate, authorizeAction("proposal:read"), intelligencePlan, listRequirementSets);
router.post(`${base}/requirement-sets`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, createRequirementSet);
router.get(`${base}/requirement-sets/:setId`, authenticate, authorizeAction("proposal:read"), intelligencePlan, readRequirementSet);
router.patch(`${base}/requirement-sets/:setId/requirements/:requirementId`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, updateRequirement);
router.post(`${base}/requirement-sets/:setId/prepare`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, prepareRequirementSet);
router.post(`${base}/requirement-sets/:setId/approve`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, approveRequirementSet);
router.post(`${base}/requirement-sets/:setId/supersede`, authenticate, authorizeAction("proposal:write"), intelligencePlan, writeLimit, supersedeRequirementSet);

export default router;
