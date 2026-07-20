import type {ContextFixture} from "./domain";
import type {deterministicContextCandidate} from "./deterministicContextModel";

export interface ProposalContextModel{
 readonly provider:string;
 readonly model:string;
 extract(proposalId:string,fixture:ContextFixture):ReturnType<typeof deterministicContextCandidate>;
}
