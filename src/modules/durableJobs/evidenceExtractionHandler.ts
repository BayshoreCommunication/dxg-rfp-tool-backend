import type { QueueMessage } from "./domain";
import { evidenceExtractionRepository } from "../evidenceExtraction/postgresEvidenceExtractionRepository";

export const handleEvidenceExtraction = async (message: QueueMessage) => {
  try {
    return await evidenceExtractionRepository.execute({
      organizationMongoId: message.organizationMongoId,
      actorUserMongoId: message.actorUserMongoId,
      runId: message.inputReference,
    });
  } catch (error) {
    const code = String((error as { code?: string }).code || "EVIDENCE_EXTRACTION_FAILED");
    await evidenceExtractionRepository.fail({
      organizationMongoId: message.organizationMongoId,
      runId: message.inputReference,
      code,
    });
    throw error;
  }
};

