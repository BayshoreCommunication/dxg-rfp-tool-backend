import { createRfpSharing } from "./application/manageRfpShares";
import { isValidShareId, mongoRfpShareRepository, mongoShareMemberDirectory, mongoSharedProposalLookup } from "./infrastructure/mongoRfpShareRepository";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";

export const rfpSharing = createRfpSharing({
  shares: mongoRfpShareRepository,
  proposals: mongoSharedProposalLookup,
  directory: mongoShareMemberDirectory,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidShareId,
});
