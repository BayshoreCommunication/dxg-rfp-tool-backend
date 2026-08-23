import { VendorIntelligenceError } from "../vendorIntelligence/domain";
import { vendorIntelligenceRepository } from "../vendorIntelligence/postgresVendorIntelligenceRepository";
import { EvaluationEngineError } from "./domain";
import { evaluationEngineRepository } from "./postgresEvaluationEngineRepository";

type AutomaticEvaluationContext = {
  organizationMongoId: string;
  actorUserMongoId: string;
  proposalMongoId: string;
  submissionMongoId: string;
  versionMongoId: string;
  correlationId: string;
};

export const prepareAutomaticEvaluation = async (input: AutomaticEvaluationContext) => {
  try {
    const intelligence = await vendorIntelligenceRepository.read(input);
    if (intelligence.run.status !== "succeeded")
      throw new EvaluationEngineError("INTELLIGENCE_RUN_NOT_READY", "Vendor intelligence is not ready for automatic evaluation.", 409);
    await vendorIntelligenceRepository.reviewAutomatically({
      ...input,
      runId: intelligence.run.runId,
    });
    const evaluation = await evaluationEngineRepository.create({
      ...input,
      intelligenceRunId: intelligence.run.runId,
      sealedPrice: false,
      idempotencyKey: `automatic-evaluation:${intelligence.run.runId}`,
    });
    await evaluationEngineRepository.completeAutomatically({
      ...input,
      runId: evaluation.runId,
    });
    return evaluationEngineRepository.read({ ...input, runId: evaluation.runId });
  } catch (error) {
    if (error instanceof VendorIntelligenceError)
      throw new EvaluationEngineError(error.code, error.message, error.status);
    throw error;
  }
};
