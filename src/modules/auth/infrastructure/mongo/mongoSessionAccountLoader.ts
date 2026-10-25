import Admin from "../../../../../modal/adminModel";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import User from "../../../../../modal/userModel";
import type { AccountType, SessionAccountLoader } from "../../domain/ports/sessionPorts";

/* Planner accounts live in `users` and administrators in `admins`. Ids are
   ObjectIds and never collide across the two collections, so the id alone
   says which kind of account a session belongs to. */
export const findSessionPrincipal = async (userId: string, organizationId: string) => {
  const filter = { _id: userId, organizationId, isBlocked: { $ne: true } };
  const user = await User.findOne(filter).select("email role").lean();
  if (user) {
    return { accountType: "planner" as AccountType, email: user.email, role: String(user.role ?? "customer") };
  }
  const admin = await Admin.findOne(filter).select("email role").lean();
  if (admin) {
    return { accountType: "admin" as AccountType, email: admin.email, role: String(admin.role ?? "admin") };
  }
  return null;
};

export const mongoSessionAccountLoader: SessionAccountLoader = {
  async load(userId, organizationId) {
    const [principal, membership] = await Promise.all([
      findSessionPrincipal(userId, organizationId),
      OrganizationMembership.findOne({ userId, organizationId, status: "active" })
        .select("roles version")
        .lean(),
    ]);
    if (!principal || !membership) return null;
    return {
      userId,
      accountType: principal.accountType,
      email: principal.email,
      organizationId,
      role: principal.role,
      roles: membership.roles,
      rolesVersion: membership.version,
    };
  },
};
