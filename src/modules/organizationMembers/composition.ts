import { membershipSessions } from "../auth/composition";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createMemberManagement } from "./application/manageMembers";
import type { TeamDirectory } from "./domain/ports";
import { mongoMembershipStore, mongoRfpReassignmentStore } from "./infrastructure/mongoMembershipStore";
import { proposalReferenceOwnershipMirror } from "./infrastructure/proposalReferenceOwnershipMirror";

// Teams arrive with ORG-201; until then every member is on no team and team changes answer 503.
// Once Team/TeamMembership are on main, replace this with a Mongo adapter over them.
const noTeamsYet: TeamDirectory = {
  teamsFor: async () => new Map(),
  activeTeamIds: async () => "unavailable",
  setMemberTeams: async () => { throw new Error("Teams are not available"); },
};

export const memberManagement = createMemberManagement({
  store: mongoMembershipStore,
  teams: noTeamsYet,
  audit: mongoSecurityAuditWriter,
  sessions: membershipSessions,
  reassignments: mongoRfpReassignmentStore,
  ownershipMirror: proposalReferenceOwnershipMirror,
});
