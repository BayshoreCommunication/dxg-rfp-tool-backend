import mongoose from "mongoose";
import Organization from "../../../../../modal/organizationModel";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import UserTwoFactor from "../../../../../modal/userTwoFactorModel";
import type { OrganizationTwoFactorDirectory } from "../../application/organizationTwoFactorPolicy";

const validIds = (ids: string[]) => ids.filter((id) => mongoose.isValidObjectId(id));

export const mongoOrganizationTwoFactorDirectory: OrganizationTwoFactorDirectory = {
  async requiresTwoFactor(organizationId) {
    const organization = await Organization.findById(organizationId).select("requireTwoFactor").lean<{ requireTwoFactor?: boolean } | null>();
    return Boolean(organization?.requireTwoFactor);
  },
  async setRequiresTwoFactor(organizationId, value) {
    await Organization.updateOne({ _id: organizationId }, { $set: { requireTwoFactor: value } });
  },
  async membership(organizationId, userId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    const membership = await OrganizationMembership.findOne({ organizationId, userId }).select("roles status").lean();
    return membership ? { roles: [...membership.roles], status: membership.status } : null;
  },
  async activeMemberIds(organizationId) {
    const rows = await OrganizationMembership.find({ organizationId, status: "active" }).select("userId").lean();
    return rows.map((row) => String(row.userId));
  },
  async enrolledUserIds(userIds) {
    const ids = validIds(userIds);
    if (!ids.length) return [];
    const rows = await UserTwoFactor.find({ userId: { $in: ids }, status: "enabled" }).select("userId").lean();
    return rows.map((row) => String(row.userId));
  },
};
