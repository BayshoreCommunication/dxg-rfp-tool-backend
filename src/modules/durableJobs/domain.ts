export type JobStatus="queued"|"running"|"retry_scheduled"|"succeeded"|"failed"|"cancelled"|"dead_letter";
export type DurableJob={id:string;type:string;status:JobStatus;inputReference:string|null;inputVersion:string|null;progress:number;progressStage:string|null;attemptCount:number;maxAttempts:number;cancellationRequested:boolean;errorCode:string|null;resultReference:string|null;createdAt:string;updatedAt:string};
export class DurableJobError extends Error { constructor(public readonly code:string,message:string,public readonly status=422){super(message);} }
// Attempts allowed before a retryable failure becomes dead_letter. ai_jobs
// .max_attempts is the per-job-type budget chosen at creation (2 for
// vendor_response_analyze, 3 for knowledge_*, 5 for source scans); the worker's
// JOB_MAX_ATTEMPTS is a global ceiling. The smaller wins, so neither a per-type
// budget nor an operator-lowered global one can be exceeded. A missing or
// invalid row value falls back to the global ceiling.
export const attemptBudget=(rowMaxAttempts:unknown,workerMaxAttempts:number):number=>{
 const declared=Number(rowMaxAttempts);
 if(!Number.isFinite(declared)||declared<1)return workerMaxAttempts;
 return Math.min(declared,workerMaxAttempts);
};
export type QueueMessage={jobId:string;organizationMongoId:string;actorUserMongoId:string;jobType:"source_security_scan"|"ai_gateway_test"|"knowledge_parse"|"knowledge_index_release"|"proposal_context_extract"|"candidate_application"|"proposal_draft_generate"|"vendor_response_analyze"|"conversation_chat";inputReference:string;inputVersion:string|null;correlationId:string;traceparent?:string};
