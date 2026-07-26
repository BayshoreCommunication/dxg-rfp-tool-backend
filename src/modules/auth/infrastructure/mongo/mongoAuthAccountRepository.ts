import mongoose from "mongoose";
import User from "../../../../../modal/userModel";
import type {
  AuthAccountRepository,
  SafeAuthUser,
} from "../../domain/ports/authAccountPorts";
import { requireDefaultOrganizationId } from "./defaultOrganization";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import { legacyRoleToMembershipRoles } from "../../../identity/application/membershipMigration";

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

export const mongoAuthAccountRepository: AuthAccountRepository = {
  async emailExists(email) {
    return Boolean(await User.exists({ email }));
  },
  async createCustomer(input) {
    const organizationId = await requireDefaultOrganizationId();
    const now = new Date();
    const id = new mongoose.Types.ObjectId();
    const user = await User.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: {
          name: input.name,
          organizationId,
          email: input.email,
          phone: input.phone,
          company: input.company,
          password: input.passwordHash,
          role: "customer",
          isBlocked: false,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("-password").lean();
    if (!user) throw new Error("Customer account was not created");
    await OrganizationMembership.updateOne(
      { organizationId, userId: user._id },
      { $setOnInsert: { roles: ["planner"], status: "active", version: 1, activatedAt: now } },
      { upsert: true },
    );
    return toSafeUser(user);
  },
  async replacePassword(email, passwordHash) {
    const result = await User.updateOne(
      { email },
      { $set: { password: passwordHash, updatedAt: new Date() } },
      { runValidators: true },
    );
    return result.matchedCount > 0;
  },
  async findCredentials(email) {
    const user = await User.findOne({ email }).select("+password").lean();
    if (!user?.password) return null;
    return {
      user: toSafeUser(user),
      passwordHash: user.password,
      isBlocked: Boolean(user.isBlocked),
    };
  },
  async findSafeById(id) {
    const user = await User.findById(id).select("-password").lean();
    return user ? toSafeUser(user) : null;
  },
  async createAdmin(input) {
    const organizationId = await requireDefaultOrganizationId();
    const now = new Date();
    const user = await User.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId() },
      {
        $setOnInsert: {
          name: input.name,
          organizationId,
          email: input.email,
          phone: input.phone,
          password: input.passwordHash,
          role: "admin",
          isBlocked: false,
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select("-password").lean();
    if (!user) throw new Error("Admin account was not created");
    await OrganizationMembership.updateOne(
      { organizationId, userId: user._id },
      { $setOnInsert: { roles: legacyRoleToMembershipRoles("admin"), status: "active", version: 1, activatedAt: now } },
      { upsert: true },
    );
    return toSafeUser(user);
  },
};
