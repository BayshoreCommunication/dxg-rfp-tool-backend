import { createPlatformAssistantApplication } from "./application";
import { approvedKnowledgeSource } from "./approvedKnowledgeSource";
import { deterministicAssistantProvider } from "./deterministicAssistantProvider";
import { openAiAssistantProvider } from "./openAiAssistantProvider";
import { postgresAssistantRepository } from "./postgresAssistantRepository";
import { createPlatformAssistantStreamingApplication } from "./streamingApplication";

export const platformAssistantRepository = postgresAssistantRepository;
export const platformAssistantApplication = createPlatformAssistantApplication(
  platformAssistantRepository,
  {
    knowledgeSource: approvedKnowledgeSource,
    responseProvider: deterministicAssistantProvider,
  },
);

export const platformAssistantStreamingApplication =
  createPlatformAssistantStreamingApplication(platformAssistantRepository, {
    knowledgeSource: approvedKnowledgeSource,
    responseProvider: openAiAssistantProvider,
  });
