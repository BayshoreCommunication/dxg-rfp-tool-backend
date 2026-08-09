const test=require("node:test"),assert=require("node:assert/strict");
const{deriveWorkflowState,parseStep,proposalWorkflowEnabled,readiness,PHASE_ORDER,ProposalWorkflowError}=require("../src/modules/proposalWorkflow/domain");
const facts=(overrides={})=>({sourceCount:0,readySourceCount:0,contextStatus:null,reviewedCount:0,appliedCount:0,draftStatus:null,gapCount:0,guidanceCount:0,guidanceBlockingCount:0,openQuestionCount:0,answeredQuestionCount:0,acceptedSectionCount:0,rejectedSectionCount:0,publishStatus:null,...overrides});
test("workflow exposes exactly the approved five steps",()=>{const steps=readiness(facts());assert.deepEqual(steps.map(x=>x.label),["Provide Information","Review the Draft","Answer Key Questions","See Guidance","Publish"]);assert.equal(steps[3].status,"gated");});
test("a step can never claim more progress than the phase supports",()=>{
 // Each step used to decide "complete" on its own and the rules disagreed.
 // A succeeded draft that nobody has read: the step is the work in progress,
 // not a finished one.
 const reviewing=readiness(facts({sourceCount:2,readySourceCount:1,contextStatus:"succeeded",reviewedCount:2,appliedCount:1,draftStatus:"succeeded",gapCount:1}));
 assert.equal(deriveWorkflowState(facts({draftStatus:"succeeded"})).phase,"reviewing");
 assert.equal(reviewing[0].status,"complete");
 assert.equal(reviewing[1].status,"in_progress","a draft nobody accepted is not a reviewed draft");
 assert.equal(reviewing[1].summary,"Draft ready · 1 known information gap(s)");
 assert.equal(reviewing[4].status,"available","publish is not reachable until the draft is reviewed");

 // Accepting a section is what finishes the review.
 const ready=readiness(facts({draftStatus:"succeeded",acceptedSectionCount:3}));
 assert.equal(ready[1].status,"complete");
 assert.equal(ready[1].summary,"3 section(s) accepted");
 assert.equal(ready[4].status,"in_progress");
 assert.equal(ready[4].summary,"Ready to publish");
});

test("Answer Key Questions counts questions, not draft gaps",()=>{
 // It measured gapCount, so it read "complete" with questions still open, and
 // was gated behind a draft even though questions precede one.
 const asking=readiness(facts({openQuestionCount:3}));
 assert.equal(deriveWorkflowState(facts({openQuestionCount:3})).phase,"intake");
 assert.equal(asking[2].status,"in_progress");
 assert.equal(asking[2].summary,"3 key question(s) remaining");
 assert.notEqual(asking[2].status,"gated","questions arrive before any draft exists");

 // Gaps are a property of the draft, so they are reported on the draft step.
 const gapsOnly=readiness(facts({draftStatus:"succeeded",gapCount:4}));
 assert.equal(gapsOnly[2].status,"complete");
 assert.equal(gapsOnly[2].summary,"No open questions");
 assert.match(gapsOnly[1].summary,/4 known information gap/);
});

test("publishing is complete only once the RFP has actually gone out",()=>{
 // Step 5 was hard-coded "available", so it looked reachable during intake and
 // never finished. The phase type carried a `published` variant that nothing
 // ever returned.
 assert.equal(readiness(facts({openQuestionCount:1}))[4].status,"available");
 const sent=facts({draftStatus:"succeeded",acceptedSectionCount:2,publishStatus:"submitted"});
 assert.equal(deriveWorkflowState(sent).phase,"published");
 assert.equal(deriveWorkflowState(sent).nextAction,"none");
 const steps=readiness(sent);
 assert.equal(steps[4].status,"complete");
 assert.equal(steps[4].summary,"Sent to vendors");
 // An unsubmitted proposal is not published, whatever else is true.
 assert.equal(deriveWorkflowState({...sent,publishStatus:"unsubmitted"}).phase,"ready");
});

test("a step may be held back by its own conditions, never advanced by them",()=>{
 const oldFlag=process.env.GUIDANCE_ENABLED;
 try{
  process.env.GUIDANCE_ENABLED="true";
  // The phase is past guidance, but nobody ran the readiness check. Holding the
  // step back is allowed; claiming it complete would not be.
  const unrun=readiness(facts({draftStatus:"succeeded",acceptedSectionCount:1}));
  assert.equal(unrun[3].status,"available");
  assert.equal(unrun[3].summary,"Readiness & risks");

  const run=readiness(facts({draftStatus:"succeeded",acceptedSectionCount:1,guidanceCount:1}));
  assert.equal(run[3].status,"complete");

  const blocked=readiness(facts({draftStatus:"succeeded",guidanceCount:1,guidanceBlockingCount:2}));
  assert.equal(deriveWorkflowState(facts({draftStatus:"succeeded",guidanceBlockingCount:2})).phase,"improving");
  assert.equal(blocked[3].status,"in_progress");
  assert.equal(blocked[3].summary,"2 blocking finding(s) need attention");
  // A blocking finding holds the draft step back too.
  assert.equal(blocked[1].status,"in_progress");

  process.env.GUIDANCE_ENABLED="false";
  assert.equal(readiness(facts({draftStatus:"succeeded",guidanceCount:1}))[3].status,"gated");
 } finally { if(oldFlag===undefined) delete process.env.GUIDANCE_ENABLED; else process.env.GUIDANCE_ENABLED=oldFlag; }
});

test("every step status agrees with the phase it was derived from",()=>{
 // The property the rewrite exists to guarantee: no combination of facts can
 // produce a step that reads complete while the phase sits before the phase
 // that completes it.
 const completesAt=["minimum_context","ready","minimum_context","reviewing","published"];
 const combos=[];
 for(const openQuestionCount of [0,2])
  for(const draftStatus of [null,"queued","succeeded"])
   for(const guidanceBlockingCount of [0,1])
    for(const acceptedSectionCount of [0,2])
     for(const publishStatus of [null,"unsubmitted","submitted"])
      combos.push(facts({openQuestionCount,draftStatus,guidanceBlockingCount,acceptedSectionCount,publishStatus,guidanceCount:1,answeredQuestionCount:1}));
 assert.equal(combos.length,72);
 for(const f of combos){
  const phase=deriveWorkflowState(f).phase, steps=readiness(f);
  steps.forEach((step,index)=>{
   if(step.status!=="complete") return;
   assert.ok(
    PHASE_ORDER.indexOf(phase)>=PHASE_ORDER.indexOf(completesAt[index]),
    "step "+(index+1)+" claimed complete in phase "+phase,
   );
  });
 }
});
test("one authoritative state drives the next beginner action",()=>{assert.equal(deriveWorkflowState(facts({openQuestionCount:2})).nextAction,"answer_questions");assert.equal(deriveWorkflowState(facts({answeredQuestionCount:5})).nextAction,"generate_draft");assert.equal(deriveWorkflowState(facts({draftStatus:"running"})).phase,"drafting");assert.equal(deriveWorkflowState(facts({draftStatus:"succeeded"})).phase,"reviewing");assert.equal(deriveWorkflowState(facts({draftStatus:"succeeded",guidanceBlockingCount:1})).phase,"improving");assert.equal(deriveWorkflowState(facts({draftStatus:"succeeded",acceptedSectionCount:4})).phase,"ready");});
test("workflow step validation is deny by default",()=>{assert.equal(parseStep(5),5);assert.throws(()=>parseStep(6),ProposalWorkflowError);assert.throws(()=>parseStep("x"),ProposalWorkflowError);});
test("workflow is test-only",()=>{const oldNode=process.env.NODE_ENV,oldFlag=process.env.PROPOSAL_WORKFLOW_ENABLED;process.env.NODE_ENV="production";process.env.PROPOSAL_WORKFLOW_ENABLED="true";assert.equal(proposalWorkflowEnabled(),false);process.env.NODE_ENV="test";assert.equal(proposalWorkflowEnabled(),true);process.env.NODE_ENV=oldNode;process.env.PROPOSAL_WORKFLOW_ENABLED=oldFlag;});

test("the Mongo publish read does not delay the Postgres work",()=>{
 // Whether the RFP has gone out is authoritative in Mongo, so the published
 // phase needs a read the workflow never used to make. Awaiting it before
 // opening the transaction — as the first version did — paid its full round
 // trip on top of the Postgres one for no reason; neither read depends on the
 // other. This checks the shape; tests-integration/proposal-workflow.test.ts
 // proves the ordering against real Postgres and Mongo, and fails if the two
 // reads are made sequential again.
 const source=require("node:fs").readFileSync(
  require("node:path").join(__dirname,"..","src/modules/proposalWorkflow/postgresProposalWorkflowRepository.ts"),"utf8");
 const parallel=source.indexOf("Promise.all([");
 assert.ok(parallel>0,"the two reads are issued together");
 assert.match(source.slice(parallel,parallel+400),/publishStatus\(/);
 assert.match(source.slice(parallel,parallel+400),/withPostgresTransaction\(/);
 assert.ok(!/const publish=await publishStatus/.test(source),"nothing awaits Mongo before the transaction");

 // Deriving labels is pure, so it happens after the connection is released
 // rather than while it is held open.
 assert.ok(source.indexOf("const present=")<source.indexOf("export const proposalWorkflowRepository"));
 assert.ok(!/withPostgresTransaction\(async c=>\{[\s\S]*?deriveWorkflowState\(/.test(source),"no presentation inside the transaction");

 // The publish status is read from Mongo, NOT mirrored onto proposal_references:
 // that mirror is best-effort and behind PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED,
 // so serving it from there would report every proposal unpublished whenever
 // the dual write is off.
 assert.match(source,/Proposal\.findOne\(\{_id:proposalMongoId,userId:actorUserMongoId\}\)\.select\("status"\)/);
});
