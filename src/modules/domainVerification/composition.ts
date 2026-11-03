import OrganizationMembership from "../../../modal/organizationMembershipModel";
import User from "../../../modal/userModel";
import { hasOrganizationAction } from "../identity/domain/authorizationPolicy";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createDomainVerification, type AdminEmailDirectory } from "./application/manageDomains";
import { nodeTxtResolver } from "./infrastructure/dns/nodeTxtResolver";
import { mongoDomainRepository } from "./infrastructure/mongo/mongoDomainRepository";

// Only consulted when DOMAIN_VERIFICATION_METHODS includes admin_email (DXG question Q7).
const mongoAdminEmailDirectory: AdminEmailDirectory = {
  async qualifies(organizationId, userId, domain) {
    const [membership, user] = await Promise.all([
      OrganizationMembership.findOne({ organizationId, userId, status: "active" }).select("roles").lean(),
      User.findOne({ _id: userId, organizationId, isBlocked: { $ne: true } }).select("email").lean(),
    ]);
    if (!membership || !user?.email) return false;
    return hasOrganizationAction(membership.roles, "organization:manage") && user.email.toLowerCase().endsWith(`@${domain}`);
  },
};

export const domainVerification = createDomainVerification({
  domains: mongoDomainRepository,
  resolver: nodeTxtResolver,
  adminEmails: mongoAdminEmailDirectory,
  audit: mongoSecurityAuditWriter,
});
