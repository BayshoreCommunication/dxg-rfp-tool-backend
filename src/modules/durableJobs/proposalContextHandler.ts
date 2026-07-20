import type {QueueMessage} from "./domain";
import {proposalContextRepository} from "../proposalContext/postgresProposalContextRepository";

export const handleProposalContext=async(message:QueueMessage)=>{try{return await proposalContextRepository.execute({organizationMongoId:message.organizationMongoId,actorUserMongoId:message.actorUserMongoId,runId:message.inputReference,correlationId:message.correlationId});}catch(error){const code=String((error as{code?:string}).code||"CONTEXT_EXTRACTION_FAILED");await proposalContextRepository.markFailed({organizationMongoId:message.organizationMongoId,actorUserMongoId:message.actorUserMongoId,runId:message.inputReference,correlationId:message.correlationId,code});throw error;}};
