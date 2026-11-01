import User from "../../../../../modal/userModel";
import type { SafeAuthUser } from "../../domain/ports/authAccountPorts";
import type { GoogleAccountRepository } from "../../domain/ports/googleIdentityPorts";
import { createCustomerWithOrganization } from "./customerOrganization";

const toSafeUser = (user: {
  _id: unknown;
  organizationId?: unknown;
  name: string;
  email: string;
  role?: string;
  phone?: string;
  company?: string;
  avatar?: string;
  createdAt?: Date;
}): SafeAuthUser => ({
  id: String(user._id),
  organizationId: user.organizationId ? String(user.organizationId) : undefined,
  name: user.name,
  email: user.email,
  role: String(user.role ?? "customer"),
  phone: user.phone,
  company: user.company,
  avatar: user.avatar,
  createdAt: user.createdAt,
});

export const mongoGoogleAccountRepository: GoogleAccountRepository = {
  async findAndLinkExisting(identity) {
    const existing = await User.findOne({ email: identity.email }).select("-password");
    if (existing) {
      if (identity.name) existing.name = identity.name;
      if (identity.avatar) existing.avatar = identity.avatar;
      existing.googleId = identity.subject;
      await existing.save();
      return {
        user: toSafeUser(existing),
        isBlocked: Boolean(existing.isBlocked),
      };
    }
    return null;
  },
  // A new Google customer becomes the Owner of a new organization of their own (ORG-106).
  async createGoogleAccount({ identity, fallbackPasswordHash }) {
    const fallbackName = identity.email.split("@")[0] || "Google User";
    const user = await createCustomerWithOrganization({
      name: identity.name || fallbackName,
      email: identity.email,
      avatar: identity.avatar,
      password: fallbackPasswordHash,
      googleId: identity.subject,
    });
    return toSafeUser(user);
  },
};
