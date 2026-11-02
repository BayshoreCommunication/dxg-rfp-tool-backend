export class TeamError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "TeamError";
  }
}

export type TeamActor = { organizationId: string; userId: string; roles: readonly string[]; correlationId: string };

export type TeamRecord = { id: string; name: string; archived: boolean; archivedAt: Date | null; createdAt: Date };
export type TeamMemberRecord = { teamId: string; userId: string; isManager: boolean };

export type TeamView = TeamRecord & { members: { userId: string; isManager: boolean }[] };
export type TeamSummary = Pick<TeamRecord, "id" | "name">;

export interface TeamRepository {
  list(organizationId: string): Promise<TeamRecord[]>;
  findById(organizationId: string, teamId: string): Promise<TeamRecord | null>;
  // "duplicate" when an active team in the organization already has the name (case-insensitive).
  create(input: { organizationId: string; name: string; createdBy: string }): Promise<TeamRecord | "duplicate">;
  rename(input: { organizationId: string; teamId: string; name: string }): Promise<TeamRecord | "duplicate" | null>;
  // False when the team is missing or already archived.
  archive(input: { organizationId: string; teamId: string; at: Date }): Promise<boolean>;
  members(organizationId: string, teamIds: readonly string[]): Promise<TeamMemberRecord[]>;
  addMember(input: { organizationId: string; teamId: string; userId: string; isManager: boolean }): Promise<"added" | "exists">;
  removeMember(input: { organizationId: string; teamId: string; userId: string }): Promise<boolean>;
  setManager(input: { organizationId: string; teamId: string; userId: string; isManager: boolean }): Promise<boolean>;
}

export interface OrganizationMemberDirectory {
  find(organizationId: string, userId: string): Promise<{ roles: readonly string[]; status: string } | null>;
}
