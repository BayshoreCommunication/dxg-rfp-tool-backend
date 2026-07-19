import type { ProposalReferenceInput, ProposalReferenceRepository } from "../domain/ports/proposalReferenceRepository";

const mongoId = /^[0-9a-f]{24}$/;
const checksum = /^[0-9a-f]{64}$/;

export const createSynchronizeProposalReference = (repository: ProposalReferenceRepository) =>
  async (input: ProposalReferenceInput) => {
    if (!mongoId.test(input.organizationMongoId) || !mongoId.test(input.ownerUserMongoId) || !mongoId.test(input.proposalMongoId)) {
      return { kind: "invalid_external_id" as const };
    }
    if (input.sourceChecksum && !checksum.test(input.sourceChecksum)) return { kind: "invalid_checksum" as const };
    const result = await repository.upsertWithOutbox(input);
    return { kind: "synchronized" as const, ...result };
  };
