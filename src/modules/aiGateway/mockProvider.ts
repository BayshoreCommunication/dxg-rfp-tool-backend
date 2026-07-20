import type {AiProvider,ProviderRequest,ProviderResult} from "./domain";
export class DeterministicMockProvider implements AiProvider{
 readonly name="mock";readonly model="deterministic-v1";
 async execute(request:ProviderRequest):Promise<ProviderResult>{
  const result=request.fixture==="invalid_output"?{unexpected:true}:{operation:request.operation,result:`synthetic:${request.fixture}`,citations:[...request.evidenceReferences]};
  const inputTokens=Math.max(1,Math.ceil(request.fixture.length/4));const outputTokens=Math.max(1,Math.ceil(JSON.stringify(result).length/4));
  return{output:result,inputTokens,outputTokens,costMicros:inputTokens+outputTokens,finishReason:"stop"};
 }
}
