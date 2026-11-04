import { createTeamAdministration } from "./application/manageTeams";
import { isValidTeamId, mongoOrganizationMemberDirectory, mongoTeamRepository } from "./infrastructure/mongoTeamRepository";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";

export const teamAdministration = createTeamAdministration({
  teams: mongoTeamRepository,
  directory: mongoOrganizationMemberDirectory,
  audit: mongoSecurityAuditWriter,
  isValidId: isValidTeamId,
});
