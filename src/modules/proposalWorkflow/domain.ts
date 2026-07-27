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
export type WorkflowFacts={sourceCount:number;readySourceCount:number;contextStatus:string|null;reviewedCount:number;appliedCount:number;draftStatus:string|null;gapCount:number;guidanceCount:number;guidanceBlockingCount:number;openQuestionCount:number;answeredQuestionCount:number;acceptedSectionCount:number;rejectedSectionCount:number};
export type WorkflowState={phase:WorkflowPhase;headline:string;nextAction:"answer_questions"|"generate_draft"|"wait_for_draft"|"review_draft"|"resolve_blockers"|"publish";nextActionLabel:string};

export class ProposalWorkflowError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
export const proposalWorkflowEnabled=()=>process.env.PROPOSAL_WORKFLOW_ENABLED==="true"&&aiRuntimeAuthorized();
export const parseStep=(value:unknown):WorkflowStep=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>5)throw new ProposalWorkflowError("WORKFLOW_STEP_INVALID","Workflow step must be between 1 and 5.",400);return n as WorkflowStep;};

export const deriveWorkflowState=(facts:WorkflowFacts):WorkflowState=>{
  if(facts.openQuestionCount>0)return{phase:"intake",headline:`${facts.openQuestionCount} important ${facts.openQuestionCount===1?"question":"questions"} left`,nextAction:"answer_questions",nextActionLabel:"Answer the next question"};
  if(facts.draftStatus==="queued"||facts.draftStatus==="running")return{phase:"drafting",headline:"Creating your first proposal draft",nextAction:"wait_for_draft",nextActionLabel:"Draft in progress"};
  if(facts.draftStatus!=="succeeded")return{phase:"minimum_context",headline:facts.answeredQuestionCount>0||facts.appliedCount>0?"Enough information for a useful first draft":"Tell us about your event",nextAction:"generate_draft",nextActionLabel:"Create my first draft"};
  if(facts.guidanceBlockingCount>0)return{phase:"improving",headline:`First draft ready — ${facts.guidanceBlockingCount} required ${facts.guidanceBlockingCount===1?"fix":"fixes"}`,nextAction:"resolve_blockers",nextActionLabel:"Fix required items"};
  if(facts.acceptedSectionCount===0)return{phase:"reviewing",headline:"Your first draft is ready to review",nextAction:"review_draft",nextActionLabel:"Review the draft"};
  return{phase:"ready",headline:facts.gapCount>0?`Draft reviewed — ${facts.gapCount} optional ${facts.gapCount===1?"improvement":"improvements"}`:"Ready to publish",nextAction:"publish",nextActionLabel:"Review and publish"};
};

export const readiness=(facts:WorkflowFacts)=>[
  { ...workflowSteps[0], status:(facts.readySourceCount>0?"complete":facts.sourceCount>0?"in_progress":"available") as WorkflowCapabilityStatus, summary:facts.readySourceCount>0?`${facts.readySourceCount} source(s) ready`:facts.sourceCount>0?"Sources are still processing":"Add information or use the detailed editor" },
  { ...workflowSteps[1], status:(facts.draftStatus==="succeeded"?"complete":facts.contextStatus?"in_progress":"available") as WorkflowCapabilityStatus, summary:facts.draftStatus==="succeeded"?"Cited draft available":facts.contextStatus?"Review extracted information":"Extract and review proposal information" },
  { ...workflowSteps[2], status:(facts.gapCount===0&&facts.draftStatus==="succeeded"?"complete":facts.draftStatus==="succeeded"?"available":"gated") as WorkflowCapabilityStatus, summary:facts.draftStatus!=="succeeded"?"Available after a draft is generated":facts.gapCount?`${facts.gapCount} known information gap(s)`:"No known information gaps" },
  { ...workflowSteps[3], status:(process.env.GUIDANCE_ENABLED!=="true"?"gated":facts.guidanceCount>0?(facts.guidanceBlockingCount>0?"in_progress":"complete"):"available") as WorkflowCapabilityStatus, summary:process.env.GUIDANCE_ENABLED!=="true"?"Investment guidance requires separate approval":facts.guidanceCount===0?"Run the readiness check for completeness and risk findings":facts.guidanceBlockingCount>0?`${facts.guidanceBlockingCount} blocking finding(s) need attention`:"Readiness check complete" },
  { ...workflowSteps[4], status:"available" as const, summary:"Uses existing validation and publishing controls" },
];
