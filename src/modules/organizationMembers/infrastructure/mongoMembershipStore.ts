import mongoose, { type ClientSession } from "mongoose";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import Proposal from "../../../../modal/proposalsModel";
import User from "../../../../modal/userModel";
import { canOwnRfps, withCustomerRole, type MemberStatus } from "../domain/memberPolicy";
import type { MemberRecord, MembershipStore, RfpReassignmentStore } from "../domain/ports";

const RFP_OWNER_ROLES = ["owner", "organization_admin", "team_manager", "planner"];

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

  // Like deactivate: when the new roles can't own RFPs (Viewer), the role write and the ownership
  // count commit together, so a concurrent reassignment to this member (which writes the same
  // membership in its transaction) either sees the Viewer and refuses or is counted here.
  async setRoles(input) {
    if (canOwnRfps(input.roles)) {
      const row = await updateVersioned(input, {}, { $set: { roles: input.roles } });
      return row ? ((await withUser(row)) as MemberRecord) : "stale";
    }
    const session = await mongoose.startSession();
    let row = null as MembershipRow | null;
    try {
      await session.withTransaction(async () => {
        row = await updateVersioned(input, {}, { $set: { roles: input.roles } }, session);
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

  async bumpVersion(input) {
    const row = await updateVersioned(input, { status: { $ne: "removed" } }, { $set: { updatedAt: new Date() } });
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

class NotOwned extends Error {
  constructor(readonly count: number) { super("selected RFPs not owned"); }
}

// The receiving member's membership is written inside the transaction, so a concurrent
// deactivation of that member (which writes the same document) serializes with this move:
// either this sees an inactive member and refuses, or the deactivation counts these RFPs.
export const mongoRfpReassignmentStore: RfpReassignmentStore = {
  async reassign(input) {
    const organizationId = objectId(input.organizationId);
    const session = await mongoose.startSession();
    let moved = null as string[] | null;
    try {
      await session.withTransaction(async () => {
        moved = null;
        const claimed = await OrganizationMembership.collection.updateOne(
          { organizationId, userId: objectId(input.toUserId), status: "active", roles: { $in: RFP_OWNER_ROLES } },
          { $set: { updatedAt: new Date() } },
          { session },
        );
        if (claimed.matchedCount === 0) return;
        const filter = {
          organizationId, userId: objectId(input.fromUserId),
          ...(input.rfpIds ? { _id: { $in: input.rfpIds.map(objectId) } } : {}),
        };
        // tenant-scoped: filter carries organizationId (built above)
        const owned = await Proposal.find(filter).select("_id").session(session).lean<{ _id: unknown }[]>();
        if (input.rfpIds && owned.length !== input.rfpIds.length) throw new NotOwned(input.rfpIds.length - owned.length);
        const ids = owned.map((p) => p._id);
        // tenant-scoped: filter is built from organizationId above
        if (ids.length) await Proposal.updateMany({ organizationId, _id: { $in: ids }, userId: objectId(input.fromUserId) }, { $set: { userId: objectId(input.toUserId) } }, { session });
        moved = ids.map(String);
      });
    } catch (error) {
      if (error instanceof NotOwned) return { notOwnedCount: error.count };
      throw error;
    } finally {
      await session.endSession();
    }
    return moved ? { rfpIds: moved } : "target_ineligible";
  },
};
