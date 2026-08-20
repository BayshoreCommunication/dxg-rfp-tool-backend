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

const router = Router();
const writeLimit = securityRateLimit({ name: "requirement-registry", limit: 60, windowMs: 15 * 60_000 });
const base = "/proposals/:proposalId/intelligence";

router.get(`${base}/requirement-sets`, authenticate, authorizeAction("proposal:read"), listRequirementSets);
router.post(`${base}/requirement-sets`, authenticate, authorizeAction("proposal:write"), writeLimit, createRequirementSet);
router.get(`${base}/requirement-sets/:setId`, authenticate, authorizeAction("proposal:read"), readRequirementSet);
router.patch(`${base}/requirement-sets/:setId/requirements/:requirementId`, authenticate, authorizeAction("proposal:write"), writeLimit, updateRequirement);
router.post(`${base}/requirement-sets/:setId/prepare`, authenticate, authorizeAction("proposal:write"), writeLimit, prepareRequirementSet);
router.post(`${base}/requirement-sets/:setId/approve`, authenticate, authorizeAction("proposal:write"), writeLimit, approveRequirementSet);
router.post(`${base}/requirement-sets/:setId/supersede`, authenticate, authorizeAction("proposal:write"), writeLimit, supersedeRequirementSet);

export default router;
