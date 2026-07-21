import crypto from "node:crypto";import Ajv from "ajv";
import {aiEnvironment} from "../../../config/aiEnvironment";
import {AiGatewayError,type AiProvider,type AiRun,type AiTestRequest} from "./domain";import type {AiGatewayRepository,ExecutionContext} from "./ports";
const checksum=(input:AiTestRequest)=>crypto.createHash("sha256").update(JSON.stringify({operation:input.operation,purpose:input.purpose,classification:input.classification,fixture:input.fixture,evidenceReferences:input.evidenceReferences})).digest("hex");
export const createAiGateway=(repository:AiGatewayRepository,provider:AiProvider)=>({
 async executeTest(context:ExecutionContext,input:AiTestRequest):Promise<AiRun>{
  if(process.env.AI_GATEWAY_ENABLED!=="true")throw new AiGatewayError("AI_GATEWAY_DISABLED","AI gateway is disabled.",503);
  if(aiEnvironment()!=="test")throw new AiGatewayError("ENVIRONMENT_NOT_AUTHORIZED","The synthetic contract-test gateway is only authorized in the test AI environment.",403);
  if(input.classification!=="synthetic"||input.purpose!=="contract_test")throw new AiGatewayError("AI_POLICY_DENIED","Only synthetic contract-test fixtures are authorized.",403);
  if(Buffer.byteLength(input.fixture)>16384)throw new AiGatewayError("AI_INPUT_TOO_LARGE","Synthetic fixture exceeds the allowed size.",413);
  const prepared=await repository.prepare(context,input,checksum(input));if(prepared.existing)return prepared.existing;
  const plan=prepared.plan!;const runId=prepared.runId!;
  if(plan.provider!=="mock"||provider.name!=="mock"||provider.model!==plan.model)throw new AiGatewayError("AI_PROVIDER_DENIED","Only the approved deterministic mock provider is available.",403);
  const started=Date.now();
  try{const result=await provider.execute({operation:input.operation,fixture:input.fixture,evidenceReferences:input.evidenceReferences,timeoutMs:plan.timeoutMs});const latency=Date.now()-started;
   if(Buffer.byteLength(JSON.stringify(result.output))>plan.maxOutputBytes)return repository.recordRejection(context,runId,["OUTPUT_TOO_LARGE"],result,latency);
   const valid=new Ajv({allErrors:true,strict:false}).compile(plan.schema)(result.output);if(!valid)return repository.recordRejection(context,runId,["SCHEMA_INVALID"],result,latency);
   const citations=(result.output as {citations?:unknown}).citations;if(!Array.isArray(citations)||citations.some(x=>!input.evidenceReferences.includes(String(x))))return repository.recordRejection(context,runId,["CITATION_INVALID"],result,latency);
   return repository.recordSuccess(context,runId,result,latency);
  }catch(error){await repository.recordFailure(context,runId,"MOCK_EXECUTION_FAILED",Date.now()-started);throw error;}
 }
});
