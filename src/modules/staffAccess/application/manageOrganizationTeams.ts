import { isPlanStaff, type PlanStaff } from "../../entitlements/application/manageOrganizationPlans";
import {
  STAFF_TEAM_AUDIT,
  StaffAccessError,
  StaffMemberError,
  unmanageableStanding,
  type StaffMemberDirectory,
  type StaffTeamDetail,
  type StaffTeamDirectory,
} from "../domain";
import { asTyped, refused } from "./manageOrganizationMembers";
import { staffMemberView, staffTeamView, type StaffContentAudit } from "./readOrganizationContent";

/* The staff read of ONE team of a customer organization, with its members. The sibling of the
   staff member read (manageOrganizationMembers.ts), built the same way.

   Staff do not change a customer organization's teams (owner decision, 2026-11-24;
   docs/DECISIONS.md). Creating, renaming and archiving a team, adding and removing a team
   member, setting a team manager and setting a member's teams, which were here from 2026-11-18,
   are removed: this service reads and nothing else, and it is given no store that can write.

   Tenant scope: the organization is the one in the path and nothing else. The team id is
   validated and the read names the path's organization with it, so a team of another
   organization is "not found". RFPilot's own organization and a legacy holding tenant are
   refused (409 ORGANIZATION_NOT_MANAGEABLE).

   Audit: after the staff check, every request leaves exactly ONE event, in the STAFF organization
   (`organizationId: staff.organizationId`), under `platform.organization_team.read`: `allowed`
   for a read that returned the team, `denied` for a refusal. Nothing is written to the customer
   organization's audit trail. */

const ID = /^[a-f0-9]{24}$/;

type Dependencies = {
  directory: StaffMemberDirectory;
  teamDirectory: StaffTeamDirectory;
  audit: StaffContentAudit;
};

type Attempt = {
  staff: PlanStaff;
  action: string;
  /** As the caller typed them: validated before they are used in a query. */
  organizationId: string;
  teamId: string;
};

const teamNotFound = () => refused(404, "TEAM_NOT_FOUND", "Team not found.");

// The answer: the team and its members through the staff reads' allowlists, each member with
// the membership's version.
const teamDetailView = (detail: StaffTeamDetail) => ({
  team: staffTeamView(detail.team),
  members: detail.members.map((entry) => ({ member: staffMemberView(entry.member), version: entry.version, isManager: entry.isManager === true })),
});

export const createStaffTeamManagement = (dependencies: Dependencies) => {
  const { directory, teamDirectory, audit } = dependencies;

  const assertStaff = (staff: PlanStaff) => {
    if (!isPlanStaff(staff)) throw new StaffAccessError("STAFF_ACCESS_FORBIDDEN", "Only RFPilot staff can do that.", 403);
    if (!staff.adminId || !staff.organizationId) throw new StaffAccessError("AUTHENTICATION_REQUIRED", "Authentication required.", 401);
  };

  // Every event of this service. Its organization is always the staff member's own; the
  // customer organization and the team appear only as the target and in the metadata.
  const eventOf = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) => ({
    organizationId: attempt.staff.organizationId,
    actorUserId: attempt.staff.adminId,
    action: attempt.action,
    targetType: "team",
    targetId: attempt.teamId,
    reason,
    correlationId: attempt.staff.correlationId,
    metadata: {
      agentAccountType: "admin",
      organizationId: attempt.organizationId,
      ...(attempt.teamId ? { teamId: attempt.teamId } : {}),
      ...metadata,
    },
  });

  // A read that returned the team. Awaited before anything is returned: if it can't be written
  // the request fails.
  const recordAllowed = (attempt: Attempt, reason: string, metadata: Record<string, unknown>) =>
    audit.append({ ...eventOf(attempt, reason, metadata), decision: "allowed" });

  // A refusal: nothing was read, so the answer is returned whether or not this can be written.
  const recordDenied = async (attempt: Attempt, error: StaffMemberError) => {
    try {
      const { targetId, ...event } = eventOf(attempt, error.code.toLowerCase(), error.status === 400 ? {} : { ...error.details });
      await audit.append({ ...event, ...(ID.test(targetId) ? { targetId } : {}), decision: "denied" });
    } catch (failure) {
      console.error("Staff team read error: a refused request could not be recorded:", failure instanceof Error ? failure.message : failure);
    }
  };

  const attempt = async <T>(
    staff: PlanStaff,
    action: string,
    where: { organizationId: unknown; teamId: unknown },
    work: (attempt: Attempt) => Promise<T>,
  ): Promise<T> => {
    assertStaff(staff);
    const current: Attempt = { staff, action, organizationId: asTyped(where.organizationId), teamId: asTyped(where.teamId) };
    try {
      return await work(current);
    } catch (error) {
      if (error instanceof StaffMemberError) await recordDenied(current, error);
      throw error;
    }
  };

  // Ids first: nothing is looked up for a malformed one.
  const validate = (current: Attempt) => {
    if (!ID.test(current.organizationId)) throw refused(400, "INVALID_ORGANIZATION_ID", "That is not an organization id.");
    if (!ID.test(current.teamId)) throw refused(400, "INVALID_TEAM_ID", "That is not a team id.");
  };

  // The organization in the path: it must exist, be a customer organization, and not be RFPilot's.
  const organizationOf = async (current: Attempt): Promise<string> => {
    const organization = await directory.organization(current.organizationId);
    if (!organization) throw refused(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
    const standing = unmanageableStanding(organization, current.staff.organizationId);
    if (standing === "platform") {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "Teams of RFPilot's own organization can't be managed here.", { standing });
    }
    if (standing) {
      throw refused(409, "ORGANIZATION_NOT_MANAGEABLE", "This organization is awaiting placement. Its teams can't be managed yet.", { standing });
    }
    return organization.id;
  };

  return {
    /** One team with its members: current data, each member with the membership's version. */
    team: (staff: PlanStaff, organizationId: string, teamId: string) =>
      attempt(staff, STAFF_TEAM_AUDIT.read, { organizationId, teamId }, async (current) => {
        validate(current);
        const organization = await organizationOf(current);
        const found = await teamDirectory.team(organization, current.teamId);
        if (!found) throw teamNotFound();
        await recordAllowed(current, "team", { resource: "team" });
        return { organizationId: organization, ...teamDetailView(found) };
      }),
  };
};

export type StaffTeamManagement = ReturnType<typeof createStaffTeamManagement>;
