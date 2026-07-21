import type {QueueMessage} from "./domain";
import {vendorAnalysisRepository} from "../vendorAnalysis/postgresVendorAnalysisRepository";

const SAFE_CODES=new Set(["VENDOR_EVIDENCE_EMPTY","VENDOR_RESPONSE_NOT_FOUND","PROPOSAL_NOT_FOUND","ANALYSIS_RUN_NOT_FOUND","ORGANIZATION_NOT_READY","LIVE_AI_CITATION_INVALID","LIVE_AI_OUTPUT_INVALID","LIVE_AI_INPUT_TOO_LARGE","LIVE_AI_EMPTY_OUTPUT","LIVE_AI_MALFORMED_OUTPUT","LIVE_AI_DISABLED","LIVE_AI_KILLED","LIVE_AI_CLASSIFICATION_DENIED","LIVE_AI_CREDENTIAL_UNAVAILABLE","LIVE_AI_PROVIDER_FAILED"]);

export const handleVendorAnalysis=async(message:QueueMessage)=>{
 try{
  return await vendorAnalysisRepository.execute({organizationMongoId:message.organizationMongoId,actorUserMongoId:message.actorUserMongoId,runId:message.inputReference});
 }catch(error){
  const code=String((error as{code?:string}).code||"VENDOR_ANALYSIS_FAILED");
  const retryable=Boolean((error as{retryable?:boolean}).retryable);
  // Temporary provider failures propagate untouched so the durable worker
  // retries; the run only settles as failed once the error is terminal.
  if(retryable&&code==="LIVE_AI_PROVIDER_TEMPORARY")throw error;
  await vendorAnalysisRepository.fail({organizationMongoId:message.organizationMongoId,runId:message.inputReference,code:SAFE_CODES.has(code)?code:"VENDOR_ANALYSIS_FAILED",status:"failed"}).catch(()=>undefined);
  throw error;
 }
};
