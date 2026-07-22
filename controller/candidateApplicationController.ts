import crypto from"node:crypto";import type{Response}from"express";import type{AuthRequest}from"../middleware/auth";import{durableJobDispatcher}from"../src/modules/durableJobs/composition";import{candidateApplicationEnabled,CandidateApplicationError,parseApplication,parseReview}from"../src/modules/candidateApplication/domain";import{candidateApplicationRepository}from"../src/modules/candidateApplication/postgresCandidateApplicationRepository";import{normalizeCandidate}from"../src/modules/candidateApplication/canonicalMapping";import{mongoProposalCandidateMutation}from"../src/modules/candidateApplication/mongoProposalCandidateMutation";import{appliedCandidateOperationIds}from"../src/modules/candidateApplication/appliedCandidateOperations";
const ctx=(req:AuthRequest)=>{if(!candidateApplicationEnabled())throw new CandidateApplicationError("CANDIDATE_APPLICATION_DISABLED","Candidate application is disabled outside the approved Slice 2E test environment.",503);if(!req.user?.organizationId||!req.user.userId)throw new CandidateApplicationError("AUTHENTICATION_REQUIRED","Authentication required.",401);return{organizationMongoId:req.user.organizationId,actorUserMongoId:req.user.userId,correlationId:String(req.headers["x-correlation-id"]||crypto.randomUUID())};};
const mongoId=(v:string)=>{if(!/^[0-9a-f]{24}$/i.test(v))throw new CandidateApplicationError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);return v;},uuid=(v:string)=>{if(!/^[0-9a-f-]{36}$/i.test(v))throw new CandidateApplicationError("RESOURCE_NOT_FOUND","Resource was not found.",404);return v;},key=(req:AuthRequest)=>{const v=String(req.headers["idempotency-key"]||"").trim();if(!v||v.length>200)throw new CandidateApplicationError("IDEMPOTENCY_KEY_REQUIRED","A valid Idempotency-Key is required.",400);return v;};
const handle=(res:Response,e:unknown)=>{const known=e instanceof CandidateApplicationError,status=known?e.status:500,code=known?e.code:"INTERNAL_ERROR";res.status(status).type("application/problem+json").json({title:known?e.message:"Candidate application failed",status,code});};
export const saveCandidateReview=async(req:AuthRequest,res:Response)=>{try{const c=ctx(req),x=parseReview(req.body as Record<string,unknown>);res.json({data:await candidateApplicationRepository.saveReview({...c,...x,proposalMongoId:mongoId(req.params.proposalId),runId:uuid(req.params.runId)})});}catch(e){handle(res,e);}};
/* A model can propose a value the canonical mapping rejects (prose where an
   enum is required). Such a candidate is unusable, but it must not take the
   whole review down with it: normalize per operation and report the failures
   as `invalidOperations` so the UI can show them as needing attention while
   every other candidate stays reviewable. */
export const readCandidateReview=async(req:AuthRequest,res:Response)=>{
  try{
    const c=ctx(req),proposalMongoId=mongoId(req.params.proposalId),runId=uuid(req.params.runId);
    const review=await candidateApplicationRepository.readReview({...c,proposalMongoId,runId});
    const invalidOperations:Array<{operationId:string;path:string;reason:string}>=[];
    const normalized=review.operations.map(operation=>{
      try{
        return normalizeCandidate(operation.path,operation.decision==="modified"?operation.modified_value:operation.value);
      }catch(error){
        invalidOperations.push({
          operationId:operation.id,
          path:operation.path,
          reason:error instanceof CandidateApplicationError?error.message:"This suggested value is not valid for the field.",
        });
        return null;
      }
    });
    const usable=normalized.filter((x):x is NonNullable<typeof x>=>x!==null);
    const snapshot=await mongoProposalCandidateMutation.snapshot({organizationMongoId:c.organizationMongoId,actorUserMongoId:c.actorUserMongoId,proposalMongoId,mongoPaths:usable.map(x=>x.mongoPath),applicationId:"review-preview"});
    if(!snapshot)throw new CandidateApplicationError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);
    const appliedOperationIds=await appliedCandidateOperationIds({...c,proposalMongoId,runId});
    res.json({data:{
      ...review,
      proposalVersion:snapshot.version,
      currentValues:Object.fromEntries(usable.map(x=>[x.canonicalPath,snapshot.values[x.mongoPath]])),
      canonicalPaths:Object.fromEntries(review.operations.flatMap((operation,index)=>normalized[index]?[[operation.id,normalized[index]!.canonicalPath]]:[])),
      appliedOperationIds,
      invalidOperations,
    }});
  }catch(e){handle(res,e);}
};
export const createCandidateApplication=async(req:AuthRequest,res:Response)=>{try{const c=ctx(req),x=parseApplication(req.body as Record<string,unknown>),r=await candidateApplicationRepository.createApplication({...c,...x,proposalMongoId:mongoId(req.params.proposalId),runId:uuid(req.params.runId),idempotencyKey:key(req)});void durableJobDispatcher.dispatch().catch(()=>undefined);res.status(r.created?202:200).json({data:{applicationId:r.application.id,jobId:r.application.job_id,status:r.application.job_status,created:r.created,statusUrl:`/api/v1/jobs/${r.application.job_id}`,resultUrl:`/api/v1/proposals/${req.params.proposalId}/candidate-applications/${r.application.id}`}});}catch(e){handle(res,e);}};
export const readCandidateApplication=async(req:AuthRequest,res:Response)=>{try{const c=ctx(req);res.json({data:await candidateApplicationRepository.readApplication({...c,proposalMongoId:mongoId(req.params.proposalId),applicationId:uuid(req.params.applicationId)})});}catch(e){handle(res,e);}};
