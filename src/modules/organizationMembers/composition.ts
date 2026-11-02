import { membershipSessions } from "../auth/composition";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createMemberManagement } from "./application/manageMembers";
import type { TeamDirectory } from "./domain/ports";
import { mongoMembershipStore, mongoRfpReassignmentStore } from "./infrastructure/mongoMembershipStore";
import { proposalReferenceOwnershipMirror } from "./infrastructure/proposalReferenceOwnershipMirror";

// Teams arrive with ORG-201; until then every member is on no team.
const noTeamsYet: TeamDirectory = { teamsFor: async () => new Map() };

export const memberManagement = createMemberManagement({
  store: mongoMembershipStore,
  teams: noTeamsYet,
  audit: mongoSecurityAuditWriter,
  sessions: membershipSessions,
  reassignments: mongoRfpReassignmentStore,
  ownershipMirror: proposalReferenceOwnershipMirror,
});
