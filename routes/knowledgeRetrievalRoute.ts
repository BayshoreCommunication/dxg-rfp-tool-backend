import{Router}from"express";import{createKnowledgeIndexJob,knowledgeIndexStatus,retrieveKnowledge}from"../controller/knowledgeRetrievalController";import{authenticate,authorizeAction}from"../middleware/auth";import{securityRateLimit}from"../middleware/securityRateLimit";
const router=Router(),indexLimit=securityRateLimit({name:"knowledge-index",limit:30,windowMs:15*60_000}),queryLimit=securityRateLimit({name:"knowledge-retrieval",limit:120,windowMs:15*60_000});
router.post("/knowledge/releases/:releaseId/index-jobs",authenticate,authorizeAction("knowledge:approve"),indexLimit,createKnowledgeIndexJob);
router.get("/knowledge/releases/:releaseId/index-status",authenticate,authorizeAction("knowledge:read"),knowledgeIndexStatus);
router.post("/knowledge/retrieval/queries",authenticate,authorizeAction("knowledge:read"),queryLimit,retrieveKnowledge);
export default router;
