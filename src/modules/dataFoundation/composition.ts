import { postgresEnabled } from "../../../config/postgres";
import { createEnsureIdentityProjection } from "./application/ensureIdentityProjection";
import { createSynchronizeProposalReference } from "./application/synchronizeProposalReference";
import { postgresIdentityProjectionRepository } from "./infrastructure/postgresIdentityProjectionRepository";
import { postgresProposalReferenceRepository } from "./infrastructure/postgresProposalReferenceRepository";

export const synchronizeProposalReference = createSynchronizeProposalReference(postgresProposalReferenceRepository);

export const ensureIdentityProjection = createEnsureIdentityProjection(
  postgresIdentityProjectionRepository,
  { enabled: postgresEnabled },
);
