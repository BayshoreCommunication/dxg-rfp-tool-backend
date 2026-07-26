import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import User from "../../../../../modal/userModel";
import type { SessionAccountLoader } from "../../domain/ports/sessionPorts";

export const mongoSessionAccountLoader: SessionAccountLoader = {
  async load(userId, organizationId) {
    const [user, membership] = await Promise.all([
      User.findOne({ _id: userId, organizationId, isBlocked: { $ne: true } })
        .select("email role")
        .lean(),
      OrganizationMembership.findOne({ userId, organizationId, status: "active" })
        .select("roles version")
        .lean(),
    ]);
    if (!user || !membership) return null;
    return {
      userId: String(user._id),
      email: user.email,
      organizationId,
      role: String(user.role ?? "customer"),
      roles: membership.roles,
      rolesVersion: membership.version,
    };
  },
};
