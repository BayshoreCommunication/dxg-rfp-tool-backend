import type {DurableJob,QueueMessage} from "./domain";
export interface JobRepository {
 createSourceScan(input:{organizationMongoId:string;actorUserMongoId:string;sourceId:string;idempotencyKey:string;correlationId:string}):Promise<{job:DurableJob;created:boolean}>;
 createAiTest(input:{organizationMongoId:string;actorUserMongoId:string;operation:string;fixture:string;evidenceReferences:string[];idempotencyKey:string;correlationId:string}):Promise<{job:DurableJob;created:boolean}>;
 createKnowledgeParse(input:{organizationMongoId:string;actorUserMongoId:string;documentId:string;idempotencyKey:string;correlationId:string}):Promise<{job:DurableJob;created:boolean}>;
 createKnowledgeIndex(input:{organizationMongoId:string;actorUserMongoId:string;releaseId:string;idempotencyKey:string;correlationId:string}):Promise<{job:DurableJob;created:boolean}>;
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
 reapExpiredLeases(limit:number):Promise<Array<{jobId:string;status:string}>>;
 listDeadLetters(limit:number):Promise<Array<Record<string,unknown>>>;
 reconcile(limit:number):Promise<QueueMessage[]>;
}
