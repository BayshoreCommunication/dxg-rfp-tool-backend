import mongoose, { type ClientSession } from "mongoose";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import Proposal from "../../../../modal/proposalsModel";
import User from "../../../../modal/userModel";
import { withCustomerRole, type MemberStatus } from "../domain/memberPolicy";
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
class Abort extends Error {
  constructor(readonly outcome: "stale" | "not_owner") { super(outcome); }
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

  // Demote first, then promote, in one transaction: the one-active-owner unique index holds at
  // every step, and a concurrent transfer or role change conflicts and retries or aborts.
  async transferOwnership(input) {
    const organizationId = objectId(input.organizationId);
    const session = await mongoose.startSession();
    let rows = null as { from: MembershipRow; to: MembershipRow } | null;
    try {
      await session.withTransaction(async () => {
        const owner = await OrganizationMembership.findOne({ organizationId, userId: objectId(input.fromUserId), status: "active", roles: "owner" })
          .session(session).select(MEMBER_FIELDS).lean<MembershipRow | null>();
        if (!owner) throw new Abort("not_owner");
        const target = await OrganizationMembership.findOne({ organizationId, userId: objectId(input.toUserId), status: "active", version: input.expectedTargetVersion })
          .session(session).select(MEMBER_FIELDS).lean<MembershipRow | null>();
        if (!target) throw new Abort("stale");
        const from = await updateVersioned(
          { organizationId: input.organizationId, userId: input.fromUserId, expectedVersion: Number(owner.version ?? 1) },
          { status: "active", roles: "owner" }, { $set: { roles: withCustomerRole(owner.roles ?? [], "organization_admin") } }, session,
        );
        if (!from) throw new Abort("not_owner");
        const to = await updateVersioned(
          { organizationId: input.organizationId, userId: input.toUserId, expectedVersion: input.expectedTargetVersion },
          { status: "active" }, { $set: { roles: withCustomerRole(target.roles ?? [], "owner") } }, session,
        );
        if (!to) throw new Abort("stale");
        rows = { from, to };
      });
    } catch (error) {
      if (error instanceof Abort) return error.outcome;
      throw error;
    } finally {
      await session.endSession();
    }
    const { from, to } = rows!;
    return { from: (await withUser(from))!, to: (await withUser(to))! };
  },
};
