import { membershipSessions } from "../auth/composition";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createMemberManagement } from "./application/manageMembers";
import { mongoMembershipStore, mongoRfpReassignmentStore } from "./infrastructure/mongoMembershipStore";
import { mongoTeamDirectory } from "./infrastructure/mongoTeamDirectory";
import { proposalReferenceOwnershipMirror } from "./infrastructure/proposalReferenceOwnershipMirror";

export const memberManagement = createMemberManagement({
  store: mongoMembershipStore,
  teams: mongoTeamDirectory,
  audit: mongoSecurityAuditWriter,
  sessions: membershipSessions,
  reassignments: mongoRfpReassignmentStore,
  ownershipMirror: proposalReferenceOwnershipMirror,
});
