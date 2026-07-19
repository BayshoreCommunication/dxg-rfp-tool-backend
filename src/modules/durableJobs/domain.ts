export type JobStatus="queued"|"running"|"retry_scheduled"|"succeeded"|"failed"|"cancelled"|"dead_letter";
export type DurableJob={id:string;type:string;status:JobStatus;inputReference:string|null;inputVersion:string|null;progress:number;progressStage:string|null;attemptCount:number;maxAttempts:number;cancellationRequested:boolean;errorCode:string|null;resultReference:string|null;createdAt:string;updatedAt:string};
export class DurableJobError extends Error { constructor(public readonly code:string,message:string,public readonly status=422){super(message);} }
export type QueueMessage={jobId:string;organizationMongoId:string;actorUserMongoId:string;jobType:"source_security_scan";inputReference:string;inputVersion:string|null;correlationId:string};
