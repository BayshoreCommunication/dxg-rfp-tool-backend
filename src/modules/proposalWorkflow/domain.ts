export const workflowSteps=[
  {id:1,key:"provide_information",label:"Provide Information"},
  {id:2,key:"review_draft",label:"Review the Draft"},
  {id:3,key:"answer_questions",label:"Answer Key Questions"},
  {id:4,key:"see_guidance",label:"See Guidance"},
  {id:5,key:"publish",label:"Publish"},
] as const;

export type WorkflowStep=1|2|3|4|5;
export type WorkflowCapabilityStatus="available"|"in_progress"|"complete"|"gated";
export type WorkflowFacts={sourceCount:number;readySourceCount:number;contextStatus:string|null;reviewedCount:number;appliedCount:number;draftStatus:string|null;gapCount:number};

export class ProposalWorkflowError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
export const proposalWorkflowEnabled=()=>process.env.PROPOSAL_WORKFLOW_ENABLED==="true"&&process.env.NODE_ENV==="test";
export const parseStep=(value:unknown):WorkflowStep=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>5)throw new ProposalWorkflowError("WORKFLOW_STEP_INVALID","Workflow step must be between 1 and 5.",400);return n as WorkflowStep;};

export const readiness=(facts:WorkflowFacts)=>[
  { ...workflowSteps[0], status:(facts.readySourceCount>0?"complete":facts.sourceCount>0?"in_progress":"available") as WorkflowCapabilityStatus, summary:facts.readySourceCount>0?`${facts.readySourceCount} source(s) ready`:facts.sourceCount>0?"Sources are still processing":"Add information or use the detailed editor" },
  { ...workflowSteps[1], status:(facts.draftStatus==="succeeded"?"complete":facts.contextStatus?"in_progress":"available") as WorkflowCapabilityStatus, summary:facts.draftStatus==="succeeded"?"Cited draft available":facts.contextStatus?"Review extracted information":"Extract and review proposal information" },
  { ...workflowSteps[2], status:(facts.gapCount===0&&facts.draftStatus==="succeeded"?"complete":facts.draftStatus==="succeeded"?"available":"gated") as WorkflowCapabilityStatus, summary:facts.draftStatus!=="succeeded"?"Available after a draft is generated":facts.gapCount?`${facts.gapCount} known information gap(s)`:"No known information gaps" },
  { ...workflowSteps[3], status:"gated" as const, summary:"Investment guidance requires separate approval" },
  { ...workflowSteps[4], status:"available" as const, summary:"Uses existing validation and publishing controls" },
];
