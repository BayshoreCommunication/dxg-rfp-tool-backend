import mongoose from "mongoose";
import User from "../../../../../modal/userModel";
import type { SafeAuthUser } from "../../domain/ports/authAccountPorts";
import type { GoogleAccountRepository } from "../../domain/ports/googleIdentityPorts";
import { requireDefaultOrganizationId } from "./defaultOrganization";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";

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
  async createGoogleAccount({ identity, fallbackPasswordHash }) {
    const organizationId = await requireDefaultOrganizationId();
    const fallbackName = identity.email.split("@")[0] || "Google User";
    const now = new Date();
    const user = await User.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId() },
      {
        $setOnInsert: {
          name: identity.name || fallbackName,
          organizationId,
          email: identity.email,
          avatar: identity.avatar,
          password: fallbackPasswordHash,
          googleId: identity.subject,
          role: "customer",
          isBlocked: false,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("-password").lean();
    if (!user) throw new Error("Google account was not created");
    await OrganizationMembership.updateOne(
      { organizationId, userId: user._id },
      { $setOnInsert: { roles: ["planner"], status: "active", version: 1, activatedAt: now } },
      { upsert: true },
    );
    return toSafeUser(user);
  },
};
