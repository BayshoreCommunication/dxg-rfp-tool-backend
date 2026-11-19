import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import {
  isValidSupportAccessId,
  mongoGrantedRfpReader,
  mongoSupportAccessDirectory,
  mongoSupportTicketLookup,
} from "../supportAccess/infrastructure/mongoSupportAccessRepository";
import { staffMembershipSessions } from "../auth/composition";
import { mongoMembershipStore, mongoRfpReassignmentStore } from "../organizationMembers/infrastructure/mongoMembershipStore";
import { proposalReferenceOwnershipMirror } from "../organizationMembers/infrastructure/proposalReferenceOwnershipMirror";
import { createStaffMemberManagement } from "./application/manageOrganizationMembers";
import { createStaffOrganizationContent } from "./application/readOrganizationContent";
import { mongoStaffMemberDirectory } from "./infrastructure/mongoStaffMemberDirectory";
import { mongoStaffOrganizationReader } from "./infrastructure/mongoStaffOrganizationReader";

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
