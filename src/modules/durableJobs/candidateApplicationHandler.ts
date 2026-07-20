import type{QueueMessage}from"./domain";import{candidateApplicationRepository}from"../candidateApplication/postgresCandidateApplicationRepository";
export const handleCandidateApplication=(message:QueueMessage)=>candidateApplicationRepository.execute({organizationMongoId:message.organizationMongoId,actorUserMongoId:message.actorUserMongoId,applicationId:message.inputReference});
