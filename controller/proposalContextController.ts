import crypto from "node:crypto";
import type {Response} from "express";
import type {AuthRequest} from "../middleware/auth";
import {durableJobDispatcher} from "../src/modules/durableJobs/composition";
import {contextEnabled,contextInput,ProposalContextError} from "../src/modules/proposalContext/domain";
import {proposalContextRepository} from "../src/modules/proposalContext/postgresProposalContextRepository";
import {latestProposalContextRunId} from "../src/modules/proposalContext/latestProposalContext";

const requestContext=(req:AuthRequest)=>{
 if(!contextEnabled())throw new ProposalContextError("PROPOSAL_CONTEXT_DISABLED","Proposal context extraction is disabled outside the approved Slice 2D test environment.",503);
 if(!req.user?.organizationId||!req.user.userId)throw new ProposalContextError("AUTHENTICATION_REQUIRED","Authentication required.",401);
 return{organizationMongoId:req.user.organizationId,actorUserMongoId:req.user.userId,correlationId:String(req.headers["x-correlation-id"]||crypto.randomUUID())};
};
const proposalId=(value:string)=>{if(!/^[0-9a-f]{24}$/i.test(value))throw new ProposalContextError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);return value;};
const runId=(value:string)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new ProposalContextError("CONTEXT_RUN_UNAVAILABLE","Context run was not found.",404);return value;};
const idempotencyKey=(req:AuthRequest)=>{const value=String(req.headers["idempotency-key"]||"").trim();if(!value||value.length>200)throw new ProposalContextError("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key is required.",400);return value;};
const handle=(res:Response,error:unknown)=>{const known=error instanceof ProposalContextError,status=known?error.status:500,code=known?error.code:"INTERNAL_ERROR";res.status(status).type("application/problem+json").json({type:`https://api.rfpilot.example/problems/${code.toLowerCase().replace(/_/g,"-")}`,title:known?error.message:"Proposal context operation failed",status,code});};

export const createProposalContextJob=async(req:AuthRequest,res:Response)=>{try{const ctx=requestContext(req),input=contextInput(req.body as Record<string,unknown>),result=await proposalContextRepository.create({...ctx,...input,proposalMongoId:proposalId(req.params.proposalId),idempotencyKey:idempotencyKey(req)});void durableJobDispatcher.dispatch().catch(()=>undefined);res.status(result.created?202:200).json({data:{jobId:result.job.id,runId:result.runId,status:result.job.status,created:result.created,statusUrl:`/api/v1/jobs/${result.job.id}`,resultUrl:`/api/v1/proposals/${req.params.proposalId}/context-runs/${result.runId}`}});}catch(error){handle(res,error);}};
export const getProposalContextRun=async(req:AuthRequest,res:Response)=>{try{const ctx=requestContext(req);res.json({data:await proposalContextRepository.read({...ctx,proposalMongoId:proposalId(req.params.proposalId),runId:runId(req.params.runId)})});}catch(error){handle(res,error);}};
export const getLatestProposalContextRun=async(req:AuthRequest,res:Response)=>{try{const ctx=requestContext(req),proposalMongoId=proposalId(req.params.proposalId),latestRunId=await latestProposalContextRunId({...ctx,proposalMongoId});res.json({data:await proposalContextRepository.read({...ctx,proposalMongoId,runId:latestRunId})});}catch(error){handle(res,error);}};
