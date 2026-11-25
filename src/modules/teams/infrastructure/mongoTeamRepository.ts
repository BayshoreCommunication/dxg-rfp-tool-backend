import mongoose from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import type { OrganizationMemberDirectory, TeamRecord, TeamRepository } from "../domain";

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

type TeamDocument = { _id: unknown; name: string; archived?: boolean; archivedAt?: Date | null; createdAt: Date };
const toRecord = (team: TeamDocument): TeamRecord => ({
  id: String(team._id),
  name: team.name,
  archived: team.archived === true,
  archivedAt: team.archivedAt ?? null,
  createdAt: team.createdAt,
});

export const mongoTeamRepository: TeamRepository = {
  async list(organizationId) {
    const teams = await Team.find({ organizationId }).sort({ archived: 1, name: 1 }).collation({ locale: "en", strength: 2 }).lean<TeamDocument[]>();
    return teams.map(toRecord);
  },

  async findById(organizationId, teamId) {
    const team = await Team.findOne({ _id: teamId, organizationId }).lean<TeamDocument | null>();
    return team ? toRecord(team) : null;
  },

  async create({ organizationId, name, createdBy }) {
    try {
      return toRecord((await Team.create({ organizationId, name, createdBy })).toObject());
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async rename({ organizationId, teamId, name }) {
    try {
      const team = await Team.findOneAndUpdate({ _id: teamId, organizationId, archived: false }, { $set: { name } }, { new: true, runValidators: true })
        .lean<TeamDocument | null>();
      return team ? toRecord(team) : null;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async archive({ organizationId, teamId, at }) {
    const result = await Team.updateOne({ _id: teamId, organizationId, archived: false }, { $set: { archived: true, archivedAt: at } });
    return result.modifiedCount === 1;
  },

  async members(organizationId, teamIds) {
    if (teamIds.length === 0) return [];
    const members = await TeamMembership.find({ organizationId, teamId: { $in: teamIds } })
      .sort({ createdAt: 1 })
      .select("teamId userId isManager")
      .lean();
    return members.map((m) => ({ teamId: String(m.teamId), userId: String(m.userId), isManager: m.isManager === true }));
  },

  async addMember({ organizationId, teamId, userId, isManager }) {
    try {
      await TeamMembership.create({ organizationId, teamId, userId, isManager });
      return "added";
    } catch (error) {
      if (isDuplicateKey(error)) return "exists";
      throw error;
    }
  },

  async removeMember({ organizationId, teamId, userId }) {
    const result = await TeamMembership.deleteOne({ organizationId, teamId, userId });
    return result.deletedCount === 1;
  },

  async setManager({ organizationId, teamId, userId, isManager }) {
    const result = await TeamMembership.updateOne({ organizationId, teamId, userId }, { $set: { isManager } });
    return result.matchedCount === 1;
  },
};

export const mongoOrganizationMemberDirectory: OrganizationMemberDirectory = {
  async find(organizationId, userId) {
    const membership = await OrganizationMembership.findOne({ organizationId, userId }).select("roles status").lean();
    return membership ? { roles: membership.roles, status: membership.status } : null;
  },
};

export const isValidTeamId = (value: string) => mongoose.isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value);

// Active teams of one organization among the ids given; archived, foreign or malformed ids are left out.
export const findActiveTeams = async (organizationId: string, teamIds: readonly string[]): Promise<TeamRecord[]> => {
  const ids = teamIds.filter(isValidTeamId);
  if (ids.length === 0) return [];
  const teams = await Team.find({ _id: { $in: ids }, organizationId, archived: false }).lean<TeamDocument[]>();
  return teams.map(toRecord);
};

// Places a member in a team inside the caller's transaction (invitation accept). False when the
// team is missing, archived or in another organization. The team document is written, not just
// read, so a concurrent archive conflicts with the transaction instead of slipping past it.
export const addMemberInTransaction = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
  at: Date;
  session: mongoose.ClientSession;
}): Promise<boolean> => {
  if (!isValidTeamId(input.teamId)) return false;
  const team = await Team.updateOne(
    { _id: input.teamId, organizationId: input.organizationId, archived: false },
    { $set: { updatedAt: input.at } },
    { session: input.session, timestamps: false },
  );
  if (team.matchedCount !== 1) return false;
  // A returning member may still be on the team; their row is kept as it is.
  await TeamMembership.updateOne(
    { teamId: input.teamId, userId: input.userId },
    { $setOnInsert: { organizationId: input.organizationId, teamId: input.teamId, userId: input.userId, isManager: false } },
    { upsert: true, session: input.session },
  );
  return true;
};
