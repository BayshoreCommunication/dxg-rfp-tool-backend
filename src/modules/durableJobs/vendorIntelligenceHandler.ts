import type { QueueMessage } from "./domain";
import { vendorIntelligenceRepository } from "../vendorIntelligence/postgresVendorIntelligenceRepository";

export const handleVendorIntelligence = async (message: QueueMessage) => {
  try {
    return await vendorIntelligenceRepository.execute({
      organizationMongoId: message.organizationMongoId,
      actorUserMongoId: message.actorUserMongoId,
      runId: message.inputReference,
    });
  } catch (error) {
    const code = String((error as { code?: string }).code || "VENDOR_INTELLIGENCE_FAILED");
    await vendorIntelligenceRepository.fail({
      organizationMongoId: message.organizationMongoId,
      runId: message.inputReference,
      code,
    });
    throw error;
  }
};
