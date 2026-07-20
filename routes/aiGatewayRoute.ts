import {Router} from "express";import {authenticate,authorizeAction} from "../middleware/auth";import {securityRateLimit} from "../middleware/securityRateLimit";import {createTestRun,getRun,listBudgets,listPolicies,listPrompts,listRuns,listSchemas} from "../controller/aiGatewayController";
const router=Router();const testLimit=securityRateLimit({name:"ai-test-run",limit:20,windowMs:15*60_000});
router.post("/ai/test-runs",authenticate,authorizeAction("security:admin"),testLimit,createTestRun);
router.get("/ai/runs",authenticate,authorizeAction("security:admin"),listRuns);router.get("/ai/runs/:runId",authenticate,authorizeAction("security:admin"),getRun);
router.get("/ai/policies",authenticate,authorizeAction("security:admin"),listPolicies);router.get("/ai/prompts",authenticate,authorizeAction("security:admin"),listPrompts);router.get("/ai/schemas",authenticate,authorizeAction("security:admin"),listSchemas);router.get("/ai/budgets",authenticate,authorizeAction("security:admin"),listBudgets);
export default router;
