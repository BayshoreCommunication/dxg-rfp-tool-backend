import { createSynchronizeProposalReference } from "./application/synchronizeProposalReference";
import { postgresProposalReferenceRepository } from "./infrastructure/postgresProposalReferenceRepository";

export const synchronizeProposalReference = createSynchronizeProposalReference(postgresProposalReferenceRepository);
