import type { QueueMessage } from "./domain";
import { proposalDraftRepository } from "../proposalDraft/postgresProposalDraftRepository";

export const handleProposalDraft = async (message: QueueMessage) => {
  try {
    return await proposalDraftRepository.execute({
      organizationMongoId: message.organizationMongoId,
      actorUserMongoId: message.actorUserMongoId,
      runId: message.inputReference,
    });
  } catch (error) {
    const code = String(
      (error as { code?: string }).code || "PROPOSAL_DRAFT_FAILED",
    );
    await proposalDraftRepository.fail({
      organizationMongoId: message.organizationMongoId,
      runId: message.inputReference,
      code,
      status: "failed",
    });
    throw error;
  }
};
