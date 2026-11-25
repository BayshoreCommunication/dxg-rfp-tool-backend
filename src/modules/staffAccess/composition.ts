import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import {
  isValidSupportAccessId,
  mongoGrantedRfpReader,
  mongoSupportAccessDirectory,
  mongoSupportTicketLookup,
} from "../supportAccess/infrastructure/mongoSupportAccessRepository";
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

/* The staff reads of one member and one team (owner decision, 2026-11-24: staff view a customer
   organization's members and teams and change neither). Each is given a read-only directory and
   the staff-side audit writer, and nothing that can write to a customer organization. */
export const staffMemberManagement = createStaffMemberManagement({
  directory: mongoStaffMemberDirectory,
  audit: mongoSecurityAuditWriter,
});

export const staffTeamManagement = createStaffTeamManagement({
  directory: mongoStaffMemberDirectory,
  teamDirectory: mongoStaffTeamDirectory,
  audit: mongoSecurityAuditWriter,
});

// Staff organization block (owner decision, 2026-11-18): the marker, the organization's sessions
// and the staff-side event commit in one transaction (infrastructure/mongoOrganizationBlockStore.ts).
export const staffOrganizationBlock = createStaffOrganizationBlock({
  directory: mongoStaffMemberDirectory,
  store: mongoOrganizationBlockStore,
  audit: mongoSecurityAuditWriter,
});
