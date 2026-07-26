import "../config/env";
import crypto from "node:crypto";
import {postgresPool} from "../config/postgres";
import {contextInput} from "../src/modules/proposalContext/domain";
import {proposalContextRepository} from "../src/modules/proposalContext/postgresProposalContextRepository";
import {durableJobDispatcher,durableJobRepository} from "../src/modules/durableJobs/composition";
import {createSourceSecurityWorker} from "../src/modules/durableJobs/worker";
import {closeQueue} from "../src/modules/durableJobs/queue";

const main=async()=>{
 if(process.env.NODE_ENV!=="test"||process.env.PROPOSAL_CONTEXT_ENABLED!=="true"||process.env.PROPOSAL_CONTEXT_PROVIDER!=="mock")throw new Error("Refusing to run outside isolated Slice 2D mock services");
 const context=await postgresPool().query<{organization:string;proposal:string;actor:string}>(`SELECT o.external_mongo_id organization,p.external_mongo_id proposal,u.external_mongo_id actor FROM rfpilot.proposal_references p JOIN rfpilot.organizations o ON o.id=p.organization_id JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE o.status='active' AND u.status='active' ORDER BY p.created_at LIMIT 1`);
 const ids=context.rows[0];if(!ids)throw new Error("An active PostgreSQL proposal reference and owner are required");
 const correlationId=crypto.randomUUID(),fixture=`synthetic-conference-simple` as const,input=contextInput({fixture});
 const created=await proposalContextRepository.create({...ids,organizationMongoId:ids.organization,proposalMongoId:ids.proposal,actorUserMongoId:ids.actor,...input,idempotencyKey:`verify-2d:${correlationId}`,correlationId});
 const worker=createSourceSecurityWorker(durableJobRepository);
 try{
  await durableJobDispatcher.dispatch();await durableJobDispatcher.reconcile();
  const deadline=Date.now()+20_000;let job=await durableJobRepository.get(ids.organization,created.job.id);
  while(!["succeeded","failed","dead_letter"].includes(job.status)&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,250));job=await durableJobRepository.get(ids.organization,created.job.id);}
  if(job.status!=="succeeded")throw new Error(`Durable proposal context job ended in ${job.status}`);
 }finally{await worker.close();await closeQueue();}
 const result=await proposalContextRepository.read({organizationMongoId:ids.organization,actorUserMongoId:ids.actor,proposalMongoId:ids.proposal,runId:created.runId});
 if(result.run.status!=="succeeded"||!result.operations.length||result.operations.some(x=>!x.evidence_ids.length)||result.proposalMutation!==false)throw new Error("Proposal context verification failed");
 console.log(JSON.stringify({runId:created.runId,jobId:created.job.id,status:result.run.status,operationCount:result.operations.length,evidenceCount:result.evidence.length,issueCount:result.issues.length,canonicalPaths:result.operations.every(x=>x.path.startsWith("/content/")),citationsPresent:result.operations.every(x=>x.evidence_ids.length>0),provider:"mock/deterministic-v1",proposalMutation:result.proposalMutation},null,2));
};
main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;}).finally(async()=>postgresPool().end());
