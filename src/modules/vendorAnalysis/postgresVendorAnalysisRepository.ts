/* eslint-disable @typescript-eslint/no-explicit-any */
import nodeCrypto from "node:crypto";
import type {PoolClient} from "pg";
import {v7 as uuidv7} from "uuid";
import {withPostgresTransaction} from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import {spacesObjectKeyFromUrl} from "../../../utils/uploadToSpaces";
import {s3PrivateDocumentStorage} from "../documentIngestion/s3PrivateDocumentStorage";
import {deterministicParser} from "../knowledgeIngestion/deterministicParser";
import {liveVendorResponseAnalysis} from "../liveAi/operations";
import {LIVE_AI_MODEL} from "../liveAi/openAiProvider";
import {buildRequirements,VendorAnalysisError} from "./domain";

const MAX_EVIDENCE=100,MAX_DOCUMENT_BYTES=20*1024*1024,MAX_FINDINGS=200;
const PRIVATE_PREFIX="vendor-responses-private/";
const MIME_BY_EXTENSION:Record<string,string>={
 pdf:"application/pdf",
 docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
 txt:"text/plain",
 csv:"text/csv",
};

const tenant=async(c:PoolClient,x:string)=>{
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)",[x]);
  const r=await c.query<{id:string}>(
   "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
   [x],
  );
  if(!r.rows[0])throw new VendorAnalysisError("ORGANIZATION_NOT_READY","Organization unavailable.",503);
  await c.query("SELECT set_config('app.organization_id',$1,true)",[r.rows[0].id]);
  return r.rows[0].id;
 },
 owned=async(c:PoolClient,p:string,u:string)=>{
  const r=await c.query<any>(
   "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2",
   [p,u],
  );
  if(!r.rows[0])throw new VendorAnalysisError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);
  return r.rows[0].id;
 },
 extensionOf=(url:string)=>String(url.split("?")[0].split("#")[0].split(".").pop()||"").toLowerCase(),
 clamp=(value:number)=>Math.min(1,Math.max(0,Number.isFinite(value)?value:0));

export const vendorAnalysisRepository={
 create(input:{
  organizationMongoId:string;
  actorUserMongoId:string;
  proposalMongoId:string;
  vendorResponseMongoId:string;
  idempotencyKey:string;
  correlationId:string;
 }){
  return withPostgresTransaction(async(c)=>{
   const org=await tenant(c,input.organizationMongoId),
    p=await owned(c,input.proposalMongoId,input.actorUserMongoId),
    key=`vendor_analysis:${input.idempotencyKey}`,
    old=await c.query<any>(
     "SELECT r.*,j.status job_status FROM rfpilot.vendor_analysis_runs r JOIN rfpilot.ai_jobs j ON j.id=r.job_id WHERE r.organization_id=$1 AND r.idempotency_key=$2",
     [org,key],
    );
   if(old.rows[0])return{run:old.rows[0],created:false};
   const runId=uuidv7(),jobId=uuidv7();
   await c.query(
    "INSERT INTO rfpilot.ai_jobs(id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,input_version,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,$3,'vendor_response_analyze','queued',$4,$5,'vendor-analysis.v1',2,$6,$7)",
    [jobId,org,p,key,runId,input.correlationId,input.actorUserMongoId],
   );
   const run=await c.query<any>(
    "INSERT INTO rfpilot.vendor_analysis_runs(id,organization_id,proposal_reference_id,vendor_response_mongo_id,job_id,actor_external_user_id,status,provider,model,idempotency_key,correlation_id,retention_until) VALUES($1,$2,$3,$4,$5,$6,'queued','openai',$7,$8,$9,now()+interval '30 days') RETURNING *",
    [runId,org,p,input.vendorResponseMongoId,jobId,input.actorUserMongoId,LIVE_AI_MODEL,key,input.correlationId],
   );
   const payload={
    jobId,
    organizationMongoId:input.organizationMongoId,
    actorUserMongoId:input.actorUserMongoId,
    jobType:"vendor_response_analyze",
    inputReference:runId,
    inputVersion:"vendor-analysis.v1",
    correlationId:input.correlationId,
   };
   await c.query(
    "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)",
    [uuidv7(),org,jobId,`job.queued:${jobId}:1`,JSON.stringify(payload)],
   );
   return{run:{...run.rows[0],job_id:jobId,job_status:"queued"},created:true};
  });
 },
 async execute(input:{organizationMongoId:string;actorUserMongoId:string;runId:string}){
  const meta=await withPostgresTransaction(async(c)=>{
   await tenant(c,input.organizationMongoId);
   const r=await c.query<any>(
    "SELECT r.*,p.external_mongo_id proposal FROM rfpilot.vendor_analysis_runs r JOIN rfpilot.proposal_references p ON p.id=r.proposal_reference_id WHERE r.id=$1 FOR UPDATE",
    [input.runId],
   );
   if(!r.rows[0])throw new VendorAnalysisError("ANALYSIS_RUN_NOT_FOUND","Vendor analysis run was not found.",404);
   if(r.rows[0].status==="succeeded")return r.rows[0];
   await c.query(
    "UPDATE rfpilot.vendor_analysis_runs SET status='running',updated_at=now() WHERE id=$1",
    [input.runId],
   );
   return r.rows[0];
  });
  if(meta.status==="succeeded")return{resultReference:input.runId};
  const response=await VendorResponse.findOne({_id:meta.vendor_response_mongo_id})
   .select("proposalId message documents")
   .lean<any>();
  if(!response||String(response.proposalId)!==String(meta.proposal)){
   await this.fail({organizationMongoId:input.organizationMongoId,runId:input.runId,code:"VENDOR_RESPONSE_NOT_FOUND",status:"failed"});
   throw new VendorAnalysisError("VENDOR_RESPONSE_NOT_FOUND","Vendor response was not found for this proposal.",404);
  }
  const proposal=await Proposal.findOne({
   _id:meta.proposal,
   userId:input.actorUserMongoId,
   organizationId:input.organizationMongoId,
  }).lean<any>();
  if(!proposal){
   await this.fail({organizationMongoId:input.organizationMongoId,runId:input.runId,code:"PROPOSAL_NOT_FOUND",status:"failed"});
   throw new VendorAnalysisError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);
  }
  const requirements=buildRequirements(proposal);
  const vendorEvidence:Array<{id:string;text:string;origin:string;locator:unknown}>=[];
  let skippedDocuments=0;
  const message=String(response.message||"").trim();
  if(message)vendorEvidence.push({id:`vendor-fragment-${vendorEvidence.length}`,text:message.slice(0,8000),origin:"message",locator:{kind:"message"}});
  for(const document of Array.isArray(response.documents)?response.documents:[]){
   if(vendorEvidence.length>=MAX_EVIDENCE)break;
   const url=String(document?.url||"");
   if(!url.includes(PRIVATE_PREFIX))continue;
   const mimeType=MIME_BY_EXTENSION[extensionOf(url)];
   if(!mimeType)continue;
   const objectKey=spacesObjectKeyFromUrl(url);
   if(!objectKey)continue;
   // NOTE: private reads use the DOCUMENT_STORAGE_* env configuration, which
   // may point at a different bucket than the vendor Spaces upload bucket;
   // unreadable or unparsable documents are skipped (counted) rather than
   // failing the whole run.
   try{
    const {bytes}=await s3PrivateDocumentStorage.read({objectKey,maxBytes:MAX_DOCUMENT_BYTES});
    const parsed=await deterministicParser.parse(bytes,mimeType);
    for(const fragment of parsed.fragments){
     if(vendorEvidence.length>=MAX_EVIDENCE)break;
     vendorEvidence.push({id:`vendor-fragment-${vendorEvidence.length}`,text:fragment.content.slice(0,8000),origin:objectKey,locator:fragment.coordinates??{}});
    }
   }catch{
    skippedDocuments+=1;
   }
  }
  void skippedDocuments;
  if(!vendorEvidence.length){
   await this.fail({organizationMongoId:input.organizationMongoId,runId:input.runId,code:"VENDOR_EVIDENCE_EMPTY",status:"failed"});
   throw new VendorAnalysisError("VENDOR_EVIDENCE_EMPTY","The vendor response contains no analyzable evidence.",422);
  }
  const live=await liveVendorResponseAnalysis(requirements,vendorEvidence,{runType:"vendor_response_analyze",runId:meta.id,organizationId:meta.organization_id});
  const findings=live.findings.slice(0,MAX_FINDINGS);
  const escalationCount=findings.filter(finding=>finding.needsHumanReview).length;
  await withPostgresTransaction(async(c)=>{
   const org=await tenant(c,input.organizationMongoId);
   const citedIds=new Set(findings.flatMap(f=>f.citations.filter(Boolean)));
   const citedEvidence=vendorEvidence.filter(e=>citedIds.has(e.id)).slice(0,200);
   for(let i=0;i<citedEvidence.length;i++){
    const item=citedEvidence[i];
    await c.query(
     "INSERT INTO rfpilot.vendor_analysis_evidence(id,organization_id,run_id,fragment_id,origin,locator,excerpt,content_checksum,ordinal) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT (run_id,fragment_id) DO NOTHING",
     [
      uuidv7(),org,input.runId,item.id,item.origin.slice(0,500),JSON.stringify(item.locator??{}),
      // A short excerpt, not the fragment: enough for a reviewer to see what
      // was cited without copying the vendor's documents into Postgres.
      item.text.slice(0,1000)||" ",
      nodeCrypto.createHash("sha256").update(item.text).digest("hex"),
      Math.min(i,199),
     ],
    );
   }
   for(let i=0;i<findings.length;i++){
    const finding=findings[i];
    await c.query(
     "INSERT INTO rfpilot.vendor_analysis_findings(id,organization_id,run_id,ordinal,kind,requirement_path,requirement_label,verdict,message,confidence,needs_human_review,citations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
     [
      uuidv7(),
      org,
      input.runId,
      Math.min(i,199),
      finding.kind,
      finding.requirementPath||null,
      finding.requirementLabel.slice(0,300),
      finding.verdict==="none"?null:finding.verdict,
      finding.message.slice(0,2000),
      clamp(finding.confidence),
      finding.needsHumanReview,
      JSON.stringify(finding.citations.filter(Boolean)),
     ],
    );
   }
   await c.query(
    "UPDATE rfpilot.vendor_analysis_runs SET status='succeeded',requirement_count=$2,finding_count=$3,escalation_count=$4,input_tokens=$5,output_tokens=$6,provider_request_id=$7,completed_at=now(),updated_at=now() WHERE id=$1",
    [
     input.runId,
     requirements.length,
     findings.length,
     escalationCount,
     live.usage.inputTokens??null,
     live.usage.outputTokens??null,
     live.usage.providerRequestId??null,
    ],
   );
  });
  return{resultReference:input.runId};
 },
 fail(input:{
  organizationMongoId:string;
  runId:string;
  code:string;
  status:"conflict"|"failed";
 }){
  return withPostgresTransaction(async(c)=>{
   await tenant(c,input.organizationMongoId);
   await c.query(
    "UPDATE rfpilot.vendor_analysis_runs SET status=$2,safe_error_code=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND status<>'succeeded'",
    [input.runId,input.status,input.code],
   );
  });
 },
 read(input:{
  organizationMongoId:string;
  actorUserMongoId:string;
  proposalMongoId:string;
  vendorResponseMongoId:string;
  runId?:string;
 }){
  return withPostgresTransaction(async(c)=>{
   await tenant(c,input.organizationMongoId);
   const p=await owned(c,input.proposalMongoId,input.actorUserMongoId),
    run=await c.query<any>(
     `SELECT * FROM rfpilot.vendor_analysis_runs WHERE proposal_reference_id=$1 AND vendor_response_mongo_id=$2 ${input.runId?"AND id=$3":"AND retention_until>now() ORDER BY created_at DESC LIMIT 1"}`,
     [p,input.vendorResponseMongoId,...(input.runId?[input.runId]:[])],
    );
   if(!run.rows[0])throw new VendorAnalysisError("ANALYSIS_RUN_NOT_FOUND","Vendor analysis run was not found.",404);
   const findings=await c.query<any>(
    "SELECT ordinal,kind,requirement_path,requirement_label,verdict,message,confidence,needs_human_review,citations FROM rfpilot.vendor_analysis_findings WHERE run_id=$1 ORDER BY ordinal",
    [run.rows[0].id],
   );
   // Returned alongside the findings so a citation id resolves to the words
   // that produced it. Without this the ids are meaningless to a reader and the
   // UI can only show the claim, never its basis.
   const evidence=await c.query<any>(
    "SELECT fragment_id,origin,locator,excerpt,content_checksum FROM rfpilot.vendor_analysis_evidence WHERE run_id=$1 ORDER BY ordinal",
    [run.rows[0].id],
   );
   const r=run.rows[0];
   return{
    evidence:evidence.rows.map((row:any)=>({
     fragmentId:row.fragment_id,
     origin:row.origin,
     locator:row.locator,
     excerpt:row.excerpt,
     checksum:row.content_checksum,
    })),
    run:{
     runId:r.id,
     jobId:r.job_id,
     vendorResponseId:r.vendor_response_mongo_id,
     status:r.status,
     provider:r.provider,
     model:r.model,
     requirementCount:r.requirement_count,
     findingCount:r.finding_count,
     escalationCount:r.escalation_count,
     safeErrorCode:r.safe_error_code,
     createdAt:r.created_at,
     completedAt:r.completed_at,
    },
    findings:findings.rows.map((finding:any)=>({
     ordinal:finding.ordinal,
     kind:finding.kind,
     requirementPath:finding.requirement_path,
     requirementLabel:finding.requirement_label,
     verdict:finding.verdict,
     message:finding.message,
     confidence:Number(finding.confidence),
     needsHumanReview:finding.needs_human_review,
     citations:finding.citations,
    })),
    proposalMutation:false,
   };
  });
 },
};
