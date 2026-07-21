import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { completeDocumentUpload, createDocumentUploadSession, createProposalNotes, deleteDocumentSource, getDocumentSource, listDocumentSources, scanDocument } from "../controller/documentSourcesController";
import { securityRateLimit } from "../middleware/securityRateLimit";

const router=Router();
router.post("/proposals/:id/sources/upload-session",authenticate,authorizeAction("proposal:write"),createDocumentUploadSession);
router.post("/proposals/:id/notes",authenticate,authorizeAction("proposal:write"),securityRateLimit({name:"proposal-notes",limit:30,windowMs:15*60_000}),createProposalNotes);
router.get("/proposals/:id/sources",authenticate,authorizeAction("proposal:read"),listDocumentSources);
router.post("/sources/:sourceId/complete",authenticate,authorizeAction("proposal:write"),completeDocumentUpload);
router.post("/sources/:sourceId/scan",authenticate,authorizeAction("proposal:write"),securityRateLimit({name:"document-scan",limit:30,windowMs:15*60_000}),scanDocument);
router.get("/sources/:sourceId",authenticate,authorizeAction("proposal:read"),getDocumentSource);
router.delete("/sources/:sourceId",authenticate,authorizeAction("proposal:write"),deleteDocumentSource);
export default router;
