import crypto from "node:crypto";
import {Worker,type Job} from "bullmq";
import type {JobRepository} from "./jobRepository";
import type {QueueMessage} from "./domain";
import {redisConnection} from "./redis";
import {SOURCE_SECURITY_QUEUE} from "./queue";
import {handleSourceSecurity} from "./sourceSecurityHandler";
import {handleKnowledgeParse} from "./knowledgeParseHandler";
import {handleKnowledgeIndex} from "./knowledgeIndexHandler";
import {handleProposalContext} from "./proposalContextHandler";
import {handleCandidateApplication} from "./candidateApplicationHandler";
import {handleProposalDraft} from "./proposalDraftHandler";
import {handleVendorAnalysis} from "./vendorAnalysisHandler";
export const createSourceSecurityWorker=(repository:JobRepository)=>{
 const workerId=`source-security-${crypto.randomUUID()}`;const leaseSeconds=Number(process.env.JOB_LEASE_SECONDS||90);const maxAttempts=Number(process.env.JOB_MAX_ATTEMPTS||5);
 return new Worker<QueueMessage>(SOURCE_SECURITY_QUEUE,async(job:Job<QueueMessage>)=>{const attempt=job.attemptsMade+1;const claimed=await repository.claim({message:job.data,workerId,attempt,leaseSeconds});if(claimed.cancelled)return{cancelled:true};const stage=job.data.jobType==="knowledge_parse"?"deterministic_parse":job.data.jobType==="knowledge_index_release"?"knowledge_index":job.data.jobType==="proposal_context_extract"?"proposal_context":job.data.jobType==="candidate_application"?"candidate_application":job.data.jobType==="proposal_draft_generate"?"proposal_draft":job.data.jobType==="vendor_response_analyze"?"vendor_analysis":"security_scan";const alive=await repository.heartbeat({message:job.data,workerId,leaseSeconds,progress:10,stage});if(!alive)return{cancelled:true};try{const result=job.data.jobType==="knowledge_parse"?await handleKnowledgeParse(job.data):job.data.jobType==="knowledge_index_release"?await handleKnowledgeIndex(job.data):job.data.jobType==="proposal_context_extract"?await handleProposalContext(job.data):job.data.jobType==="candidate_application"?await handleCandidateApplication(job.data):job.data.jobType==="proposal_draft_generate"?await handleProposalDraft(job.data):job.data.jobType==="vendor_response_analyze"?await handleVendorAnalysis(job.data):await handleSourceSecurity(job.data);await repository.complete({message:job.data,workerId,attempt,resultReference:result.resultReference});return result;}catch(error){const retryable=Boolean((error as {retryable?:boolean}).retryable);const code=String((error as {code?:string}).code||"JOB_HANDLER_FAILED");await repository.fail({message:job.data,workerId,attempt,diagnosticCode:code,retryable,maxAttempts});if(retryable)throw error;return{failed:true,code};}},{connection:redisConnection(),concurrency:Number(process.env.SOURCE_SECURITY_CONCURRENCY||2),lockDuration:leaseSeconds*1000,stalledInterval:15000,maxStalledCount:2});
};
