import {Router} from "express";
import {createProposalContextJob,createSourceProposalContextJob,getLatestProposalContextRun,getProposalContextRun} from "../controller/proposalContextController";
import {authenticate,authorizeAction} from "../middleware/auth";
import {securityRateLimit} from "../middleware/securityRateLimit";

const router=Router(),createLimit=securityRateLimit({name:"proposal-context",limit:30,windowMs:15*60_000});
router.post("/proposals/:proposalId/context-jobs",authenticate,authorizeAction("proposal:write"),createLimit,createProposalContextJob);
router.post("/proposals/:proposalId/live-context-jobs",authenticate,authorizeAction("proposal:write"),createLimit,createProposalContextJob);
router.post("/proposals/:proposalId/live-source-context-jobs",authenticate,authorizeAction("proposal:write"),createLimit,createSourceProposalContextJob);
router.get("/proposals/:proposalId/context-runs/latest",authenticate,authorizeAction("proposal:read"),getLatestProposalContextRun);
router.get("/proposals/:proposalId/context-runs/:runId",authenticate,authorizeAction("proposal:read"),getProposalContextRun);
export default router;
