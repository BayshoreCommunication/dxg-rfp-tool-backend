import crypto from "node:crypto";
import type { Response } from "express";
import mongoose from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import { documentIngestion, documentIngestionEnabled } from "../src/modules/documentIngestion/composition";
import { DocumentIngestionError } from "../src/modules/documentIngestion/domain";
import { getOwnedProposal } from "../src/modules/proposals/composition";

const context = (req: AuthRequest) => {
  if (!documentIngestionEnabled()) throw new DocumentIngestionError("FEATURE_DISABLED", "Private document ingestion is disabled.", 503);
  if (!req.user?.organizationId || !req.user.userId) throw new DocumentIngestionError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  return { organizationMongoId: req.user.organizationId, userMongoId: req.user.userId, correlationId: String(req.headers["x-correlation-id"] || crypto.randomUUID()) };
};
const handle = (res: Response, error: unknown) => {
  const known=error instanceof DocumentIngestionError; const status=known?error.status:500;
  res.status(status).type("application/problem+json").json({ type:`https://api.rfpilot.example/problems/${known?error.code.toLowerCase().replace(/_/g,"-"):"internal-error"}`, title:known?error.message:"Document operation failed", status, code:known?error.code:"INTERNAL_ERROR" });
};
const sourceId=(value:string)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new DocumentIngestionError("SOURCE_NOT_FOUND","Document source was not found.",404);return value;};
const ownsProposal = async (proposalId:string, _organizationId:string, userId:string) => {
  if(!mongoose.isValidObjectId(proposalId)) throw new DocumentIngestionError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);
  const result=await getOwnedProposal({proposalId,ownerUserId:userId});
  if(result.kind==="not_found") throw new DocumentIngestionError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);
};

export const createDocumentUploadSession = async(req:AuthRequest,res:Response)=>{try{
  const ctx=context(req); await ownsProposal(req.params.id,ctx.organizationMongoId,ctx.userMongoId);
  const body=req.body as Record<string,unknown>; const result=await documentIngestion.createUpload({...ctx,proposalMongoId:req.params.id,filename:String(body.filename||""),mimeType:String(body.mimeType||""),sizeBytes:Number(body.sizeBytes),classification:String(body.classification||"confidential"),idempotencyKey:String(req.headers["idempotency-key"]||"")});
  res.status(result.created?201:200).json({data:result});
}catch(error){handle(res,error);}};
export const completeDocumentUpload=async(req:AuthRequest,res:Response)=>{try{res.json({data:await documentIngestion.complete({...context(req),sourceId:sourceId(req.params.sourceId)})});}catch(error){handle(res,error);}};
export const scanDocument=async(req:AuthRequest,res:Response)=>{try{res.json({data:await documentIngestion.scan({...context(req),sourceId:sourceId(req.params.sourceId)})});}catch(error){handle(res,error);}};
export const getDocumentSource=async(req:AuthRequest,res:Response)=>{try{const ctx=context(req);const result=await documentIngestion.get(ctx.organizationMongoId,sourceId(req.params.sourceId));const {objectKey:_private,...source}=result;res.json({data:source});}catch(error){handle(res,error);}};
export const listDocumentSources=async(req:AuthRequest,res:Response)=>{try{const ctx=context(req);await ownsProposal(req.params.id,ctx.organizationMongoId,ctx.userMongoId);res.json({data:await documentIngestion.list(ctx.organizationMongoId,req.params.id,Math.min(Math.max(Number(req.query.limit)||25,1),100))});}catch(error){handle(res,error);}};
export const deleteDocumentSource=async(req:AuthRequest,res:Response)=>{try{res.json({data:await documentIngestion.remove({...context(req),sourceId:sourceId(req.params.sourceId)})});}catch(error){handle(res,error);}};
