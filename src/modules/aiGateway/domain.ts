export const AI_OPERATIONS=["extractStructured","classify","summarize","generateFromEvidence"] as const;
export const AI_SYNTHETIC_FIXTURES=["basic","invalid_output","prompt_injection"] as const;
export type AiOperation=typeof AI_OPERATIONS[number];
export type AiRunStatus="policy_checking"|"budget_reserved"|"started"|"validating"|"succeeded"|"rejected"|"failed"|"cancelled";
export type AiTestRequest={operation:AiOperation;purpose:"contract_test";classification:"synthetic";fixture:typeof AI_SYNTHETIC_FIXTURES[number];evidenceReferences:string[];idempotencyKey:string;correlationId:string};
export type AiRun={id:string;operation:string;purpose:string;classification:string;provider:string;model:string;promptVersion:string;schemaVersion:string;status:AiRunStatus;inputTokens:number|null;outputTokens:number|null;costMicros:number|null;reservedCostMicros:number;latencyMs:number|null;finishReason:string|null;output:unknown;correlationId:string;createdAt:string;completedAt:string|null};
export type ProviderRequest={operation:AiOperation;fixture:string;evidenceReferences:string[];timeoutMs:number};
export type ProviderResult={output:unknown;inputTokens:number;outputTokens:number;costMicros:number;finishReason:string};
export interface AiProvider {readonly name:string;readonly model:string;execute(request:ProviderRequest):Promise<ProviderResult>}
export class AiGatewayError extends Error{constructor(public readonly code:string,message:string,public readonly status=422){super(message);}}
