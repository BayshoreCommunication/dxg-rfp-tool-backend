import type {DurableJob,QueueMessage} from "./domain";
export interface JobRepository {
 createSourceScan(input:{organizationMongoId:string;actorUserMongoId:string;sourceId:string;idempotencyKey:string;correlationId:string}):Promise<{job:DurableJob;created:boolean}>;
 get(organizationMongoId:string,jobId:string):Promise<DurableJob>;
 list(organizationMongoId:string,limit:number):Promise<DurableJob[]>;
 cancel(input:{organizationMongoId:string;jobId:string;actorUserMongoId:string;correlationId:string}):Promise<DurableJob>;
 retry(input:{organizationMongoId:string;jobId:string;actorUserMongoId:string;reason:string;correlationId:string}):Promise<DurableJob>;
 claim(input:{message:QueueMessage;workerId:string;attempt:number;leaseSeconds:number}):Promise<{job:DurableJob;cancelled:boolean}>;
 heartbeat(input:{message:QueueMessage;workerId:string;leaseSeconds:number;progress:number;stage:string}):Promise<boolean>;
 complete(input:{message:QueueMessage;workerId:string;attempt:number;resultReference?:string}):Promise<DurableJob>;
 fail(input:{message:QueueMessage;workerId:string;attempt:number;diagnosticCode:string;retryable:boolean;maxAttempts:number}):Promise<DurableJob>;
 claimOutbox(limit:number,dispatcherId:string):Promise<Array<{eventId:string;message:QueueMessage}>>;
 markOutboxPublished(eventId:string):Promise<void>;
 markOutboxFailed(eventId:string,code:string):Promise<void>;
 reconcile(limit:number):Promise<QueueMessage[]>;
}

