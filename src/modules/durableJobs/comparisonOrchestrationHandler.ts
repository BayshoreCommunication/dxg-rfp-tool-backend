import type { QueueMessage } from "./domain";
import { comparisonOrchestrationRepository } from "../comparisonOrchestration/postgresComparisonOrchestrationRepository";

export const handleComparisonParticipant = (message: QueueMessage) => comparisonOrchestrationRepository.executeParticipant({
  organizationMongoId: message.organizationMongoId,
  actorUserMongoId: message.actorUserMongoId,
  participantId: message.inputReference,
});

export const handleComparisonAggregate = (message: QueueMessage) => comparisonOrchestrationRepository.executeAggregate({
  organizationMongoId: message.organizationMongoId,
  actorUserMongoId: message.actorUserMongoId,
  runId: message.inputReference,
});
