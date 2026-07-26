import {deterministicContextCandidate} from "./deterministicContextModel";
import type {ProposalContextModel} from "./ports";

class DeterministicProposalContextProvider implements ProposalContextModel{
 readonly provider="mock";
 readonly model="deterministic-v1";
 extract(proposalId:Parameters<ProposalContextModel["extract"]>[0],fixture:Parameters<ProposalContextModel["extract"]>[1]){return deterministicContextCandidate(proposalId,fixture);}
}

export const proposalContextModel:ProposalContextModel=new DeterministicProposalContextProvider();
