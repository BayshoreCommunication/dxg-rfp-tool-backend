import { createPlatformAssistantApplication } from "./application";
import { approvedKnowledgeSource } from "./approvedKnowledgeSource";
import { deterministicAssistantProvider } from "./deterministicAssistantProvider";
import { postgresAssistantRepository } from "./postgresAssistantRepository";

export const platformAssistantRepository = postgresAssistantRepository;
export const platformAssistantApplication = createPlatformAssistantApplication(
  platformAssistantRepository,
  {
    knowledgeSource: approvedKnowledgeSource,
    responseProvider: deterministicAssistantProvider,
  },
);
