import type { QueueMessage } from "./domain";
import { vendorIntelligenceRepository } from "../vendorIntelligence/postgresVendorIntelligenceRepository";

export const handleVendorIntelligence = (
  message: QueueMessage,
  onProgress?: (progress: number, stage: string) => Promise<void> | void,
) => vendorIntelligenceRepository.execute({
  organizationMongoId: message.organizationMongoId,
  actorUserMongoId: message.actorUserMongoId,
  runId: message.inputReference,
  onProgress,
});
