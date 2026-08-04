import {aiRuntimeAuthorized} from "../../../config/aiEnvironment";
export const workflowSteps=[
  {id:1,key:"provide_information",label:"Provide Information"},
  {id:2,key:"review_draft",label:"Review the Draft"},
  {id:3,key:"answer_questions",label:"Answer Key Questions"},
  {id:4,key:"see_guidance",label:"See Guidance"},
  {id:5,key:"publish",label:"Publish"},
] as const;

export type WorkflowStep=1|2|3|4|5;
export type WorkflowCapabilityStatus="available"|"in_progress"|"complete"|"gated";
export type WorkflowPhase="intake"|"minimum_context"|"drafting"|"reviewing"|"improving"|"ready"|"published";
export type WorkflowFacts={sourceCount:number;readySourceCount:number;contextStatus:string|null;reviewedCount:number;appliedCount:number;draftStatus:string|null;gapCount:number;guidanceCount:number;guidanceBlockingCount:number;openQuestionCount:number;answeredQuestionCount:number;acceptedSectionCount:number;rejectedSectionCount:number;publishStatus:string|null};
export type WorkflowState={phase:WorkflowPhase;headline:string;nextAction:"answer_questions"|"generate_draft"|"wait_for_draft"|"review_draft"|"resolve_blockers"|"publish"|"none";nextActionLabel:string};

/**
 * How far along a proposal is, most to least. `deriveWorkflowState` picks one
 * of these and `readiness` projects the five steps out of it, so a step can
 * never claim "complete" while the phase says otherwise.
 *
 * `improving` ranks below `reviewing` deliberately: a blocking guidance finding
 * is a harder stop than an unreviewed section, so a proposal with one is less
 * far along than one that merely awaits review.
 */
export const PHASE_ORDER=["intake","minimum_context","drafting","improving","reviewing","ready","published"] as const;
const rank=(phase:WorkflowPhase)=>PHASE_ORDER.indexOf(phase);

export class ProposalWorkflowError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
export const proposalWorkflowEnabled=()=>process.env.PROPOSAL_WORKFLOW_ENABLED==="true"&&aiRuntimeAuthorized();
export const parseStep=(value:unknown):WorkflowStep=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>5)throw new ProposalWorkflowError("WORKFLOW_STEP_INVALID","Workflow step must be between 1 and 5.",400);return n as WorkflowStep;};

export const deriveWorkflowState=(facts:WorkflowFacts):WorkflowState=>{
  // Once the RFP has gone out to vendors the assistant has nothing left to ask
  // for. Without this the phase type carried a `published` variant nothing ever
  // returned, so the Publish step could never read as done.
  if(facts.publishStatus&&facts.publishStatus!=="unsubmitted")return{phase:"published",headline:"This RFP has been sent to vendors",nextAction:"none",nextActionLabel:"View responses"};
  if(facts.openQuestionCount>0)return{phase:"intake",headline:`${facts.openQuestionCount} important ${facts.openQuestionCount===1?"question":"questions"} left`,nextAction:"answer_questions",nextActionLabel:"Answer the next question"};
  if(facts.draftStatus==="queued"||facts.draftStatus==="running")return{phase:"drafting",headline:"Creating your first proposal draft",nextAction:"wait_for_draft",nextActionLabel:"Draft in progress"};
  if(facts.draftStatus!=="succeeded")return{phase:"minimum_context",headline:facts.answeredQuestionCount>0||facts.appliedCount>0?"Enough information for a useful first draft":"Tell us about your event",nextAction:"generate_draft",nextActionLabel:"Create my first draft"};
  if(facts.guidanceBlockingCount>0)return{phase:"improving",headline:`First draft ready — ${facts.guidanceBlockingCount} required ${facts.guidanceBlockingCount===1?"fix":"fixes"}`,nextAction:"resolve_blockers",nextActionLabel:"Fix required items"};
  if(facts.acceptedSectionCount===0)return{phase:"reviewing",headline:"Your first draft is ready to review",nextAction:"review_draft",nextActionLabel:"Review the draft"};
  return{phase:"ready",headline:facts.gapCount>0?`Draft reviewed — ${facts.gapCount} optional ${facts.gapCount===1?"improvement":"improvements"}`:"Ready to publish",nextAction:"publish",nextActionLabel:"Review and publish"};
};

/**
 * The five steps, derived from the phase rather than decided independently.
 *
 * Each step used to carry its own rule for "complete", and those rules
 * disagreed with the phase and with each other. Step 2 called itself complete
 * the moment a draft existed, before anyone had read it. Step 3 — "Answer Key
 * Questions" — measured *draft gaps* rather than questions, so it read
 * "complete" while questions were still open, and was gated behind a draft even
 * though questions arrive from the conversation and precede one. Step 5 was
 * hard-coded "available", so publishing looked ready during intake.
 *
 * Now a step declares which phase completes it and which phases it is the
 * active work of; everything else follows from `deriveWorkflowState`. A step
 * may still add a condition of its own — an unrun readiness check, a disabled
 * capability — but only to hold a step back, never to claim progress the phase
 * does not support.
 */
type StepProjection={
  completeAt:WorkflowPhase;
  active:readonly WorkflowPhase[];
  /** False keeps a step at "available" during its own phase: the work exists
   *  but the planner has not begun it. Never used to mark one complete. */
  started:(facts:WorkflowFacts)=>boolean;
  gated?:(facts:WorkflowFacts)=>boolean;
  /** Held back inside its own completing phase — an extra requirement the
   *  phase does not model, such as a readiness check nobody has run. */
  withheld?:(facts:WorkflowFacts)=>boolean;
  summary:(facts:WorkflowFacts,status:WorkflowCapabilityStatus)=>string;
};

const PROJECTIONS:readonly StepProjection[]=[
  { // Provide Information — the intake conversation and uploaded sources.
    completeAt:"minimum_context", active:["intake"],
    started:f=>f.sourceCount>0||f.answeredQuestionCount>0||f.appliedCount>0,
    summary:(f,status)=>status==="available"?"Add information or use the detailed editor"
      :f.readySourceCount>0?`${f.readySourceCount} source(s) ready`
      :f.sourceCount>0?"Sources are still processing"
      :`${f.answeredQuestionCount} answer(s) recorded`,
  },
  { // Review the Draft — not done until a person has accepted something.
    completeAt:"ready", active:["drafting","improving","reviewing"],
    started:f=>f.draftStatus!==null||f.contextStatus!==null,
    summary:(f,status)=>status==="complete"?`${f.acceptedSectionCount} section(s) accepted`
      :f.draftStatus==="queued"||f.draftStatus==="running"?"Draft in progress"
      :f.draftStatus==="succeeded"?(f.gapCount?`Draft ready · ${f.gapCount} known information gap(s)`:"Draft ready to review")
      :f.contextStatus?"Review extracted information":"Extract and review proposal information",
  },
  { // Answer Key Questions — the questions themselves, not draft gaps.
    completeAt:"minimum_context", active:["intake"],
    started:f=>f.openQuestionCount>0||f.answeredQuestionCount>0,
    summary:(f,status)=>status==="complete"?(f.answeredQuestionCount?`${f.answeredQuestionCount} question(s) answered`:"No open questions")
      :f.openQuestionCount?`${f.openQuestionCount} key question(s) remaining`
      :"Questions appear as the assistant learns about your event",
  },
  { // See Guidance — a separately approved capability, and one a planner has
    // to actually run; neither is something the phase can know.
    completeAt:"reviewing", active:["improving"],
    started:f=>f.guidanceCount>0,
    gated:()=>process.env.GUIDANCE_ENABLED!=="true",
    withheld:f=>f.guidanceCount===0,
    summary:(f,status)=>status==="gated"?"Investment guidance requires separate approval"
      :f.guidanceCount===0?"Readiness & risks"
      :f.guidanceBlockingCount>0?`${f.guidanceBlockingCount} blocking finding(s) need attention`
      :"Readiness check complete",
  },
  { // Publish — complete only once the RFP has actually gone out.
    completeAt:"published", active:["ready"],
    started:()=>true,
    summary:(f,status)=>status==="complete"?"Sent to vendors"
      :status==="in_progress"?"Ready to publish"
      :"Uses existing validation and publishing controls",
  },
];

export const readiness=(facts:WorkflowFacts)=>{
  const current=rank(deriveWorkflowState(facts).phase);
  return PROJECTIONS.map((projection,index)=>{
    const status:WorkflowCapabilityStatus=
      projection.gated?.(facts) ? "gated"
      : current>=rank(projection.completeAt) && !projection.withheld?.(facts) ? "complete"
      : projection.active.some(phase=>rank(phase)===current) && projection.started(facts) ? "in_progress"
      : "available";
    return { ...workflowSteps[index], status, summary:projection.summary(facts,status) };
  });
};
