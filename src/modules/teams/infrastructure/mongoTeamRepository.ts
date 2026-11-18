import mongoose, { type ClientSession } from "mongoose";
import Team from "../../../../modal/teamModel";
import TeamMembership from "../../../../modal/teamMembershipModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import { appendAudit } from "../../organizationMembers/infrastructure/mongoMembershipStore";
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

/* A write that carries an audit event (an RFPilot staff change; owner decision 2026-11-18) runs
   here: the change and the event commit together or neither does. The event goes to
   `audit.organizationId` (the STAFF organization), never to the team's organization. A write
   without an event never opens a transaction: the member paths below are what they were. */
const inTransaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result = undefined as T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export const mongoTeamRepository: TeamRepository = {
  async list(organizationId) {
    const teams = await Team.find({ organizationId }).sort({ archived: 1, name: 1 }).collation({ locale: "en", strength: 2 }).lean<TeamDocument[]>();
    return teams.map(toRecord);
  },

  async findById(organizationId, teamId) {
    const team = await Team.findOne({ _id: teamId, organizationId }).lean<TeamDocument | null>();
    return team ? toRecord(team) : null;
  },

  async create({ organizationId, name, createdBy, audit }) {
    if (audit) {
      try {
        return await inTransaction(async (session) => {
          const [team] = await Team.create([{ organizationId, name, createdBy }], { session });
          const created = toRecord(team.toObject());
          await appendAudit({ ...audit, targetId: created.id }, session, { teamId: created.id });
          return created;
        });
      } catch (error) {
        if (isDuplicateKey(error)) return "duplicate";
        throw error;
      }
    }
    try {
      return toRecord((await Team.create({ organizationId, name, createdBy })).toObject());
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async rename({ organizationId, teamId, name, audit }) {
    if (audit) {
      try {
        return await inTransaction(async (session) => {
          const previous = await Team.findOne({ _id: teamId, organizationId, archived: false }).select("name").session(session).lean<{ name: string } | null>();
          if (!previous) return null;
          const team = await Team.findOneAndUpdate({ _id: teamId, organizationId, archived: false }, { $set: { name } }, { new: true, runValidators: true, session })
            .lean<TeamDocument | null>();
          if (!team) return null;
          await appendAudit(audit, session, { before: { name: previous.name }, changed: previous.name !== team.name });
          return toRecord(team);
        });
      } catch (error) {
        if (isDuplicateKey(error)) return "duplicate";
        throw error;
      }
    }
    try {
      const team = await Team.findOneAndUpdate({ _id: teamId, organizationId, archived: false }, { $set: { name } }, { new: true, runValidators: true })
        .lean<TeamDocument | null>();
      return team ? toRecord(team) : null;
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  },

  async archive({ organizationId, teamId, at, audit }) {
    if (audit) {
      return inTransaction(async (session) => {
        const result = await Team.updateOne({ _id: teamId, organizationId, archived: false }, { $set: { archived: true, archivedAt: at } }, { session });
        if (result.modifiedCount !== 1) return false;
        await appendAudit(audit, session);
        return true;
      });
    }
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

  async addMember({ organizationId, teamId, userId, isManager, audit }) {
    if (audit) {
      try {
        return await inTransaction(async (session) => {
          await TeamMembership.create([{ organizationId, teamId, userId, isManager }], { session });
          await appendAudit(audit, session);
          return "added" as const;
        });
      } catch (error) {
        if (isDuplicateKey(error)) return "exists";
        throw error;
      }
    }
    try {
      await TeamMembership.create({ organizationId, teamId, userId, isManager });
      return "added";
    } catch (error) {
      if (isDuplicateKey(error)) return "exists";
      throw error;
    }
  },

  async removeMember({ organizationId, teamId, userId, audit }) {
    if (audit) {
      return inTransaction(async (session) => {
        const removed = await TeamMembership.findOneAndDelete({ organizationId, teamId, userId }, { session }).select("isManager").lean<{ isManager?: boolean } | null>();
        if (!removed) return false;
        await appendAudit(audit, session, { before: { userId, isManager: removed.isManager === true } });
        return true;
      });
    }
    const result = await TeamMembership.deleteOne({ organizationId, teamId, userId });
    return result.deletedCount === 1;
  },

  async setManager({ organizationId, teamId, userId, isManager, audit }) {
    if (audit) {
      return inTransaction(async (session) => {
        const previous = await TeamMembership.findOneAndUpdate({ organizationId, teamId, userId }, { $set: { isManager } }, { new: false, session })
          .select("isManager").lean<{ isManager?: boolean } | null>();
        if (!previous) return false;
        await appendAudit(audit, session, { before: { isManager: previous.isManager === true }, changed: (previous.isManager === true) !== isManager });
        return true;
      });
    }
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
