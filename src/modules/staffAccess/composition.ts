import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import {
  isValidSupportAccessId,
  mongoGrantedRfpReader,
  mongoSupportAccessDirectory,
  mongoSupportTicketLookup,
} from "../supportAccess/infrastructure/mongoSupportAccessRepository";
import { staffMembershipSessions } from "../auth/composition";
import { mongoMembershipStore, mongoRfpReassignmentStore } from "../organizationMembers/infrastructure/mongoMembershipStore";
import { mongoStaffMemberTeams, mongoTeamDirectory } from "../organizationMembers/infrastructure/mongoTeamDirectory";
import { proposalReferenceOwnershipMirror } from "../organizationMembers/infrastructure/proposalReferenceOwnershipMirror";
import { createTeamAdministration } from "../teams/application/manageTeams";
import { isValidTeamId, mongoOrganizationMemberDirectory, mongoTeamRepository } from "../teams/infrastructure/mongoTeamRepository";
import { createStaffOrganizationBlock } from "./application/manageOrganizationBlock";
import { createStaffMemberManagement } from "./application/manageOrganizationMembers";
import { createStaffTeamManagement } from "./application/manageOrganizationTeams";
import { createStaffOrganizationContent } from "./application/readOrganizationContent";
import { mongoOrganizationBlockStore } from "./infrastructure/mongoOrganizationBlockStore";
import { mongoStaffMemberDirectory } from "./infrastructure/mongoStaffMemberDirectory";
import { mongoStaffOrganizationReader } from "./infrastructure/mongoStaffOrganizationReader";
import { mongoStaffTeamDirectory } from "./infrastructure/mongoStaffTeamDirectory";

export const staffOrganizationContent = createStaffOrganizationContent({
  organizations: mongoStaffOrganizationReader,
  proposals: mongoGrantedRfpReader,
  directory: mongoSupportAccessDirectory,
  tickets: mongoSupportTicketLookup,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidSupportAccessId,
});

// Staff member management (owner decision, 2026-11-18): the customer's own membership store and
// reassignment store, with the staff session hook (no event in the customer organization).
export const staffMemberManagement = createStaffMemberManagement({
  directory: mongoStaffMemberDirectory,
  store: mongoMembershipStore,
  reassignments: mongoRfpReassignmentStore,
  ownershipMirror: proposalReferenceOwnershipMirror,
  sessions: staffMembershipSessions,
  audit: mongoSecurityAuditWriter,
});

/* Staff team management (owner decision, 2026-11-18): the customer's own team rules over the
   customer's own team store. This instance of the team service has NO writer for the member
   events (`team.*`): the service never writes one for a staff actor, and if it ever tried to,
   the request would fail instead of leaving a row in the customer organization. */
const staffTeamRules = createTeamAdministration({
  teams: mongoTeamRepository,
  directory: mongoOrganizationMemberDirectory,
  audit: {
    append: async () => {
      throw new Error("A staff team change never writes an event in the customer organization.");
    },
  },
  isValidId: isValidTeamId,
});

export const staffTeamManagement = createStaffTeamManagement({
  directory: mongoStaffMemberDirectory,
  teamDirectory: mongoStaffTeamDirectory,
  teams: staffTeamRules,
  members: mongoMembershipStore,
  memberTeams: { activeTeamIds: mongoTeamDirectory.activeTeamIds, setMemberTeams: mongoStaffMemberTeams.setMemberTeams },
  audit: mongoSecurityAuditWriter,
});

// Staff organization block (owner decision, 2026-11-18): the marker, the organization's sessions
// and the staff-side event commit in one transaction (infrastructure/mongoOrganizationBlockStore.ts).
export const staffOrganizationBlock = createStaffOrganizationBlock({
  directory: mongoStaffMemberDirectory,
  store: mongoOrganizationBlockStore,
  audit: mongoSecurityAuditWriter,
});
