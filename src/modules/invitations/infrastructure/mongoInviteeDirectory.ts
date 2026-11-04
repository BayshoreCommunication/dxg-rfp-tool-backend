import mongoose from "mongoose";
import Organization from "../../../../modal/organizationModel";
import OrganizationMembership from "../../../../modal/organizationMembershipModel";
import User from "../../../../modal/userModel";
import type { InviteeDirectory, InviteeStanding, OrganizationDirectory } from "../domain/ports";

type UserRow = { _id: mongoose.Types.ObjectId; email: string; organizationId?: mongoose.Types.ObjectId | null; isBlocked?: boolean };
type MembershipRow = { userId: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; status: InviteeStanding["membershipHere"] };

// Standing of each user against one organization. Shared by invite (per row) and accept (inside
// the transaction, with its session) so both apply the same rules.
export const standingsForUsers = async (
  organizationId: string,
  users: readonly UserRow[],
  session?: mongoose.ClientSession,
): Promise<Map<string, InviteeStanding>> => {
  const result = new Map<string, InviteeStanding>();
  if (!users.length) return result;
  const memberships = await OrganizationMembership.find({ userId: { $in: users.map((user) => user._id) } })
    .select("userId organizationId status")
    .session(session ?? null)
    .lean<MembershipRow[]>();
  const organizationIds = new Set<string>([
    ...memberships.map((membership) => String(membership.organizationId)),
    ...users.flatMap((user) => (user.organizationId ? [String(user.organizationId)] : [])),
  ]);
  const holdingIds = new Set(
    (await Organization.find({ _id: { $in: [...organizationIds] }, kind: "legacy_holding" })
      .select("_id")
      .session(session ?? null)
      .lean<{ _id: unknown }[]>()).map((organization) => String(organization._id)),
  );
  for (const user of users) {
    const own = memberships.filter((membership) => String(membership.userId) === String(user._id));
    const here = own.find((membership) => String(membership.organizationId) === organizationId);
    result.set(user.email, {
      userId: String(user._id),
      blocked: Boolean(user.isBlocked),
      membershipHere: here?.status ?? null,
      activeElsewhere: own.some((membership) => membership.status === "active" && String(membership.organizationId) !== organizationId),
      // Still in a holding tenant until ORG-110 places them: by their account, or by any
      // membership in one that hasn't been removed.
      inLegacyHolding:
        (user.organizationId ? holdingIds.has(String(user.organizationId)) : false) ||
        own.some((membership) => membership.status !== "removed" && holdingIds.has(String(membership.organizationId))),
    });
  }
  return result;
};

export const mongoInviteeDirectory: InviteeDirectory = {
  async standings(organizationId, emails) {
    if (!emails.length) return new Map();
    const users = await User.find({ email: { $in: emails } }).select("_id email organizationId isBlocked").lean<UserRow[]>();
    return standingsForUsers(organizationId, users);
  },
};

export const mongoOrganizationDirectory: OrganizationDirectory = {
  async find(organizationId) {
    if (!mongoose.isValidObjectId(organizationId)) return null;
    const organization = await Organization.findById(organizationId)
      .select("name status kind allowManagerInvites")
      .lean<{ _id: unknown; name: string; status: string; kind?: string; allowManagerInvites?: boolean } | null>();
    if (!organization) return null;
    return {
      id: String(organization._id),
      name: organization.name,
      allowManagerInvites: Boolean(organization.allowManagerInvites),
      // Holding tenants keep one legacy user's data apart; nobody joins them by invitation.
      invitable: organization.status === "active" && (organization.kind ?? "customer") === "customer",
    };
  },
  async userName(userId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    const user = await User.findById(userId).select("name").lean<{ name?: string } | null>();
    return user?.name?.trim() || null;
  },
};
