import mongoose, { type ClientSession } from "mongoose";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import Proposal from "../../../../modal/proposalsModel";
import User from "../../../../modal/userModel";
import type { MemberStatus } from "../domain/memberPolicy";
import type { MemberRecord, MembershipStore } from "../domain/ports";

type MembershipRow = {
  _id: unknown; userId: unknown; roles?: string[]; status: MemberStatus; version?: number;
  lastSignedInAt?: Date | null; createdAt?: Date | null;
};
type UserRow = { _id: unknown; name?: string; email?: string };

const objectId = (value: string) => new mongoose.Types.ObjectId(value);
const isObjectId = (value: string) => /^[a-f0-9]{24}$/i.test(value);

const toRecord = (row: MembershipRow, user?: UserRow | null): MemberRecord => ({
  membershipId: String(row._id),
  userId: String(row.userId),
  name: user?.name ?? null,
  email: user?.email ?? null,
  roles: [...(row.roles ?? [])],
  status: row.status,
  version: Number(row.version ?? 1),
  lastSignedInAt: row.lastSignedInAt ?? null,
  createdAt: row.createdAt ?? null,
});

const MEMBER_FIELDS = "userId roles status version lastSignedInAt createdAt";

const withUser = async (row: MembershipRow | null): Promise<MemberRecord | null> => {
  if (!row) return null;
  const user = await User.findById(row.userId).select("name email").lean<UserRow | null>();
  return toRecord(row, user);
};

class OwnedRfps extends Error {
  constructor(readonly count: number) { super("member owns RFPs"); }
}

// Proposal.userId is the owner (modal/proposalsModel.ts).
export const countOwnedRfps = (organizationId: string, userId: string, session?: ClientSession) =>
  Proposal.countDocuments({ organizationId: objectId(organizationId), userId: objectId(userId) }).session(session ?? null);

// Optimistic update on (organization, user, version). Returns null when the version moved.
const updateVersioned = (
  input: { organizationId: string; userId: string; expectedVersion: number },
  extra: Record<string, unknown>,
  update: Record<string, unknown>,
  session?: ClientSession,
) =>
  OrganizationMembership.findOneAndUpdate(
    { organizationId: objectId(input.organizationId), userId: objectId(input.userId), version: input.expectedVersion, ...extra },
    { ...update, $inc: { version: 1 } },
    { new: true, runValidators: true, session },
  ).select(MEMBER_FIELDS).lean<MembershipRow | null>();

export const mongoMembershipStore: MembershipStore = {
  async list(organizationId) {
    const rows = await OrganizationMembership.find({ organizationId: objectId(organizationId) })
      .select(MEMBER_FIELDS).lean<MembershipRow[]>();
    const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select("name email").lean<UserRow[]>();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return rows.map((row) => toRecord(row, byId.get(String(row.userId))));
  },

  async find(organizationId, userId) {
    if (!isObjectId(userId)) return null;
    return withUser(await OrganizationMembership.findOne({ organizationId: objectId(organizationId), userId: objectId(userId) })
      .select(MEMBER_FIELDS).lean<MembershipRow | null>());
  },

  countOwnedRfps: (organizationId, userId) => countOwnedRfps(organizationId, userId),

  async setRoles(input) {
    const row = await updateVersioned(input, {}, { $set: { roles: input.roles } });
    return row ? ((await withUser(row)) as MemberRecord) : "stale";
  },

  // The status change and the ownership count commit together. An RFP reassignment to this
  // member writes the same membership document in its own transaction, so the two serialize:
  // either the reassignment sees an inactive member, or this count sees the reassigned RFPs.
  async deactivate(input) {
    const session = await mongoose.startSession();
    let row = null as MembershipRow | null;
    try {
      await session.withTransaction(async () => {
        row = await updateVersioned(input, { status: { $ne: "removed" } }, { $set: { status: "suspended", suspendedAt: input.now } }, session);
        if (!row) return;
        const owned = await countOwnedRfps(input.organizationId, input.userId, session);
        if (owned > 0) throw new OwnedRfps(owned);
      });
    } catch (error) {
      if (error instanceof OwnedRfps) return { ownedRfpCount: error.count };
      throw error;
    } finally {
      await session.endSession();
    }
    if (!row) return "stale";
    // An RFP the member created while this committed would be orphaned; put the member back.
    const owned = await countOwnedRfps(input.organizationId, input.userId);
    if (owned > 0) {
      await OrganizationMembership.updateOne(
        { organizationId: objectId(input.organizationId), userId: objectId(input.userId), status: "suspended" },
        { $set: { status: "active", suspendedAt: null }, $inc: { version: 1 } },
      );
      return { ownedRfpCount: owned };
    }
    return (await withUser(row)) as MemberRecord;
  },

  async reactivate(input) {
    const row = await updateVersioned(input, { status: "suspended" }, { $set: { status: "active", suspendedAt: null, activatedAt: new Date() } });
    return row ? ((await withUser(row)) as MemberRecord) : "stale";
  },
};
