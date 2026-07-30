import { createPlatformAssistantApplication } from "./application";
import { approvedKnowledgeSource } from "./approvedKnowledgeSource";
import { deterministicAssistantProvider } from "./deterministicAssistantProvider";
import { openAiAssistantProvider } from "./openAiAssistantProvider";
import { postgresAssistantRepository } from "./postgresAssistantRepository";
import { createPlatformAssistantStreamingApplication } from "./streamingApplication";
import { mongoAssistantProposalContextSource } from "./selectedProposalSource";

export const platformAssistantRepository = postgresAssistantRepository;
export const platformAssistantApplication = createPlatformAssistantApplication(
  platformAssistantRepository,
  {
    knowledgeSource: approvedKnowledgeSource,
    responseProvider: deterministicAssistantProvider,
    proposalContextSource: mongoAssistantProposalContextSource,
  },
);

export const platformAssistantStreamingApplication =
  createPlatformAssistantStreamingApplication(platformAssistantRepository, {
    knowledgeSource: approvedKnowledgeSource,
    responseProvider: openAiAssistantProvider,
    proposalContextSource: mongoAssistantProposalContextSource,
  });
