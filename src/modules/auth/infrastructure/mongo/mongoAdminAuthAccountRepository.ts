import mongoose from "mongoose";
import Admin from "../../../../../modal/adminModel";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import type {
  AuthAccountRepository,
  SafeAuthUser,
} from "../../domain/ports/authAccountPorts";
import { requireDefaultOrganizationId } from "./defaultOrganization";
import { legacyRoleToMembershipRoles } from "../../../identity/application/membershipMigration";

const toSafeAdmin = (admin: {
  _id: unknown;
  organizationId?: unknown;
  name: string;
  email: string;
  role?: string;
  phone?: string;
  avatar?: string;
  createdAt?: Date;
}): SafeAuthUser => ({
  id: String(admin._id),
  organizationId: admin.organizationId ? String(admin.organizationId) : undefined,
  name: admin.name,
  email: admin.email,
  role: String(admin.role ?? "admin"),
  phone: admin.phone,
  avatar: admin.avatar,
  createdAt: admin.createdAt,
});

/* The admin side of credential sign-in, admin signup and admin password
   reset. Only the `admins` collection is ever read or written here, so a
   planner account with the same email can neither sign in to the admin nor
   have its password reset through the admin flow. */
export const mongoAdminAuthAccountRepository: AuthAccountRepository = {
  async emailExists(email) {
    return Boolean(await Admin.exists({ email }));
  },
  async createCustomer() {
    throw new Error("Planner accounts are not created in the admins collection");
  },
  async replacePassword(email, passwordHash) {
    const result = await Admin.updateOne(
      { email },
      { $set: { password: passwordHash, updatedAt: new Date() } },
    );
    return result.matchedCount > 0;
  },
  async findCredentials(email) {
    const admin = await Admin.findOne({ email }).select("+password").lean();
    if (!admin?.password) return null;
    return {
      user: toSafeAdmin(admin),
      passwordHash: admin.password,
      isBlocked: Boolean(admin.isBlocked),
    };
  },
  async findSafeById(id) {
    const admin = await Admin.findById(id).select("-password").lean();
    return admin ? toSafeAdmin(admin) : null;
  },
  async createAdmin(input) {
    const organizationId = await requireDefaultOrganizationId();
    const now = new Date();
    const admin = await Admin.findOneAndUpdate(
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
    if (!admin) throw new Error("Admin account was not created");
    await OrganizationMembership.updateOne(
      { organizationId, userId: admin._id },
      { $setOnInsert: { roles: legacyRoleToMembershipRoles("admin"), status: "active", version: 1, activatedAt: now } },
      { upsert: true },
    );
    return toSafeAdmin(admin);
  },
};
