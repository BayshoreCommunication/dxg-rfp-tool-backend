import type {AiRun,AiTestRequest,ProviderResult} from "./domain";
export type ExecutionContext={organizationMongoId:string;actorUserMongoId:string};
export type ExecutionPlan={organizationId:string;policyId:string;promptId:string;schemaId:string;provider:string;model:string;promptVersion:string;schemaVersion:string;timeoutMs:number;schema:object;maxInputBytes:number;maxOutputBytes:number;reservationMicros:number};
export interface AiGatewayRepository{
 getTestRequest(organizationMongoId:string,requestId:string):Promise<{operation:AiTestRequest["operation"];fixture:AiTestRequest["fixture"];evidenceReferences:string[];idempotencyKey:string;correlationId:string}>;
 prepare(context:ExecutionContext,input:AiTestRequest,inputChecksum:string):Promise<{existing?:AiRun;runId?:string;plan?:ExecutionPlan}>;
 recordSuccess(context:ExecutionContext,runId:string,result:ProviderResult,latencyMs:number):Promise<AiRun>;
 recordRejection(context:ExecutionContext,runId:string,safeCodes:string[],result:ProviderResult,latencyMs:number):Promise<AiRun>;
 recordFailure(context:ExecutionContext,runId:string,code:string,latencyMs:number):Promise<void>;
 get(organizationMongoId:string,runId:string):Promise<AiRun>;
 list(organizationMongoId:string,limit:number):Promise<AiRun[]>;
 policies(organizationMongoId:string):Promise<unknown[]>;prompts(organizationMongoId:string):Promise<unknown[]>;schemas(organizationMongoId:string):Promise<unknown[]>;budgets(organizationMongoId:string):Promise<unknown[]>;
}
