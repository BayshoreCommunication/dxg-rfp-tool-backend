import type{PoolClient}from"pg";import{v7 as uuidv7}from"uuid";import{withPostgresTransaction}from"../../../config/postgres";import{deriveWorkflowState,ProposalWorkflowError,readiness,type WorkflowFacts,type WorkflowStep}from"./domain";import Proposal from"../../../modal/proposalsModel";
// Whether the RFP has gone out lives in Mongo with the rest of the proposal,
// not in the AI domain, so the Publish step could never read as done from
// Postgres alone. Read here rather than in the SQL facts for that reason.
const publishStatus=async(proposalMongoId:string,actorUserMongoId:string):Promise<string|null>=>{
 const p=await Proposal.findOne({_id:proposalMongoId,userId:actorUserMongoId}).select("status").lean<{status?:string}>();
 return p?.status??null;
};
type WorkflowRow={id:string;status:string;current_step:WorkflowStep;updated_at:Date};type FactsRow={source_count:number;ready_source_count:number;context_status:string|null;reviewed_count:number;applied_count:number;draft_status:string|null;gap_count:number|null;guidance_count:number|null;guidance_blocking_count:number|null;open_question_count:number;answered_question_count:number;accepted_section_count:number;rejected_section_count:number};
const tenant=async(c:PoolClient,mongoId:string)=>{await c.query("SELECT set_config('app.organization_mongo_id',$1,true)",[mongoId]);const o=await c.query<{id:string}>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",[mongoId]);if(!o.rows[0])throw new ProposalWorkflowError("ORGANIZATION_NOT_READY","Organization data foundation is unavailable.",503);await c.query("SELECT set_config('app.organization_id',$1,true)",[o.rows[0].id]);return o.rows[0].id;};
const proposal=async(c:PoolClient,org:string,proposalMongoId:string,owner:string)=>{const p=await c.query<{id:string}>(`SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.organization_id=$1 AND p.external_mongo_id=$2 AND u.external_mongo_id=$3`,[org,proposalMongoId,owner]);if(!p.rows[0])throw new ProposalWorkflowError("PROPOSAL_NOT_FOUND","Proposal was not found.",404);return p.rows[0].id;};
const facts=async(c:PoolClient,org:string,pid:string)=>{const r=await c.query<FactsRow>(`SELECT
 (SELECT count(*)::int FROM rfpilot.document_sources WHERE organization_id=$1 AND proposal_reference_id=$2 AND status<>'deleted') source_count,
 (SELECT count(*)::int FROM rfpilot.document_sources WHERE organization_id=$1 AND proposal_reference_id=$2 AND status='ready') ready_source_count,
 (SELECT status FROM rfpilot.proposal_context_runs WHERE organization_id=$1 AND proposal_reference_id=$2 ORDER BY created_at DESC LIMIT 1) context_status,
 (SELECT count(*)::int FROM rfpilot.candidate_review_decisions d JOIN rfpilot.candidate_review_sets v ON v.id=d.review_set_id WHERE v.organization_id=$1 AND v.proposal_reference_id=$2 AND d.decision<>'pending') reviewed_count,
 (SELECT count(*)::int FROM rfpilot.candidate_application_items i JOIN rfpilot.candidate_applications a ON a.id=i.application_id WHERE a.organization_id=$1 AND a.proposal_reference_id=$2 AND a.status='applied') applied_count,
 (SELECT status FROM rfpilot.proposal_draft_runs WHERE organization_id=$1 AND proposal_reference_id=$2 ORDER BY created_at DESC LIMIT 1) draft_status,
 (SELECT gap_count::int FROM rfpilot.proposal_draft_runs WHERE organization_id=$1 AND proposal_reference_id=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1) gap_count,
 (SELECT count(*)::int FROM rfpilot.guidance_reports WHERE organization_id=$1 AND proposal_reference_id=$2) guidance_count,
 (SELECT blocking_count::int FROM rfpilot.guidance_reports WHERE organization_id=$1 AND proposal_reference_id=$2 ORDER BY created_at DESC LIMIT 1) guidance_blocking_count,
 (SELECT count(*)::int FROM rfpilot.clarification_questions WHERE organization_id=$1 AND proposal_reference_id=$2 AND status='open') open_question_count,
 (SELECT count(*)::int FROM rfpilot.clarification_questions WHERE organization_id=$1 AND proposal_reference_id=$2 AND status='answered') answered_question_count,
 (SELECT count(*)::int FROM rfpilot.proposal_draft_section_decisions d JOIN rfpilot.proposal_draft_runs dr ON dr.id=d.run_id WHERE dr.organization_id=$1 AND dr.proposal_reference_id=$2 AND d.decision='accepted') accepted_section_count,
 (SELECT count(*)::int FROM rfpilot.proposal_draft_section_decisions d JOIN rfpilot.proposal_draft_runs dr ON dr.id=d.run_id WHERE dr.organization_id=$1 AND dr.proposal_reference_id=$2 AND d.decision='rejected') rejected_section_count`,[org,pid]);const x=r.rows[0]??{};return{sourceCount:x.source_count??0,readySourceCount:x.ready_source_count??0,contextStatus:x.context_status??null,reviewedCount:x.reviewed_count??0,appliedCount:x.applied_count??0,draftStatus:x.draft_status??null,gapCount:x.gap_count??0,guidanceCount:x.guidance_count??0,guidanceBlockingCount:x.guidance_blocking_count??0,openQuestionCount:x.open_question_count??0,answeredQuestionCount:x.answered_question_count??0,acceptedSectionCount:x.accepted_section_count??0,rejectedSectionCount:x.rejected_section_count??0};};
// Presentation is built here rather than inside the transaction: it is pure,
// and holding a Postgres connection open while deriving labels is wasteful.
const present=(row:WorkflowRow,postgresFacts:Omit<WorkflowFacts,"publishStatus">,publish:string|null)=>{
 const f:WorkflowFacts={...postgresFacts,publishStatus:publish};
 return{
  workflow:{id:row.id,status:row.status,currentStep:row.current_step,updatedAt:row.updated_at},
  state:deriveWorkflowState(f),facts:f,steps:readiness(f),
  boundaries:{proposalAuthority:"mongodb",aiRecords:"postgresql",queue:"reference-only",generatedProseMutation:false,liveProvider:false},
 };
};

// The publish status is in Mongo and everything else is in Postgres, and
// neither read depends on the other, so they go out together. Awaiting the
// Mongo round trip first — as this did when the published phase was added —
// paid its full latency on top of the transaction for no reason.
const readParts=<T>(input:{organizationMongoId:string;actorUserMongoId:string;proposalMongoId:string},work:(c:PoolClient,org:string,pid:string)=>Promise<T>)=>
 Promise.all([
  publishStatus(input.proposalMongoId,input.actorUserMongoId),
  withPostgresTransaction(async c=>{
   const org=await tenant(c,input.organizationMongoId),pid=await proposal(c,org,input.proposalMongoId,input.actorUserMongoId);
   const row=await work(c,org,pid);
   return{row,f:await facts(c,org,pid)};
  }),
 ]);

export const proposalWorkflowRepository={
 async read(input:{organizationMongoId:string;actorUserMongoId:string;proposalMongoId:string}){
  const [publish,base]=await readParts(input,async(c,org,pid)=>{
   const found=await c.query<WorkflowRow>("SELECT id,status,current_step,updated_at FROM rfpilot.proposal_workflows WHERE organization_id=$1 AND proposal_reference_id=$2",[org,pid]);
   if(found.rows[0])return found.rows[0];
   const created=await c.query<WorkflowRow>(`INSERT INTO rfpilot.proposal_workflows(id,organization_id,proposal_reference_id,owner_external_user_id) VALUES($1,$2,$3,$4) RETURNING id,status,current_step,updated_at`,[uuidv7(),org,pid,input.actorUserMongoId]);
   return created.rows[0];
  });
  return present(base.row,base.f,publish);
 },
 async setStep(input:{organizationMongoId:string;actorUserMongoId:string;proposalMongoId:string;step:WorkflowStep}){
  const [publish,base]=await readParts(input,async(c,org,pid)=>{
   const saved=await c.query<WorkflowRow>(`INSERT INTO rfpilot.proposal_workflows(id,organization_id,proposal_reference_id,owner_external_user_id,current_step) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,proposal_reference_id) DO UPDATE SET current_step=EXCLUDED.current_step,updated_at=now() RETURNING id,status,current_step,updated_at`,[uuidv7(),org,pid,input.actorUserMongoId,input.step]);
   return saved.rows[0];
  });
  return present(base.row,base.f,publish);
 }
};
