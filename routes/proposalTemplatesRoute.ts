import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { proposalTemplatesController as controller } from "../controller/proposalTemplatesController";

// ORG-604: RFP templates (DXG decision Q4). Every route needs a signed-in member whose role can
// use templates; Viewers are refused here. Which template a member may see or change is decided
// in manageProposalTemplates. None of these routes accepts a public access grant. Templates are
// not a plan feature: only starting an RFP from one is limited, by the plan's RFP slot.
const router = Router();
const use = [authenticate, authorizeAction("template:use")];
const manage = [authenticate, authorizeAction("template:publish")];

router.get("/proposal-templates", ...use, controller.list);
router.post("/proposal-templates", ...use, controller.create);
router.get("/proposal-templates/:templateId", ...use, controller.get);
router.patch("/proposal-templates/:templateId", ...use, controller.update);
router.post("/proposal-templates/:templateId/publish", ...manage, controller.publish);
router.post("/proposal-templates/:templateId/unpublish", ...manage, controller.unpublish);
router.post("/proposal-templates/:templateId/archive", ...use, controller.archive);
router.post("/proposal-templates/:templateId/restore", ...use, controller.restore);
// Starting an RFP is also an RFP write, like POST /api/proposals.
router.post("/proposal-templates/:templateId/proposals", ...use, authorizeAction("proposal:write"), controller.createProposal);

export default router;
