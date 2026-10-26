import Admin from "../../../../../modal/adminModel";
import OrganizationMembership from "../../../../../modal/organizationMembershipModel";
import RefreshSession from "../../../../../modal/refreshSessionModel";
import type { AdminUserRepository } from "../../domain/ports/adminUserRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";
import { legacyRoleToMembershipRoles } from "../../../identity/application/membershipMigration";

const safeUser = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/* Administrators live in the `admins` collection. Their organization
   membership carries the roles every authorize() check reads, so it is kept in
   step here: created with the account, re-roled (with a version bump that
   forces a fresh sign-in) when the role changes, and removed on delete. */
export const mongoAdminUserRepository: AdminUserRepository = {
  async list() {
    const admins = await Admin.find(tenantFilter())
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
    return admins.map(safeUser);
  },
  async emailExists(email) {
    // Admin emails are unique across the whole collection, not per tenant.
    return Boolean(await Admin.exists({ email }));
  },
  async findById(id) {
    const admin = await Admin.findOne({ _id: id, ...tenantFilter() }).select("role").lean();
    return admin ? { id: String(admin._id), role: admin.role, data: safeUser(admin) } : null;
  },
  async create(input) {
    const { organizationId } = tenantFilter();
    const created = await Admin.create({ ...input, organizationId });
    await OrganizationMembership.updateOne(
      { organizationId, userId: created._id },
      {
        $setOnInsert: {
          roles: legacyRoleToMembershipRoles(input.role),
          status: "active",
          version: 1,
          activatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    const admin = await Admin.findById(created._id).select("-password").lean();
    if (!admin) throw new Error("Admin user disappeared after creation");
    return safeUser(admin);
  },
  async update(id, patch) {
    const update: Record<string, unknown> = { ...patch };
    if (patch.passwordHash !== undefined) {
      update.password = patch.passwordHash;
      delete update.passwordHash;
    }
    const admin = await Admin.findOneAndUpdate({ _id: id, ...tenantFilter() }, { $set: update }, {
      new: true,
      runValidators: false,
    }).select("-password").lean();
    if (!admin) throw new Error("Admin user disappeared during update");
    if (patch.role !== undefined) {
      await OrganizationMembership.updateOne(
        { ...tenantFilter(), userId: admin._id, status: "active" },
        {
          $set: { roles: legacyRoleToMembershipRoles(patch.role), updatedAt: new Date() },
          $inc: { version: 1 },
        },
      );
    }
    return safeUser(admin);
  },
  async deleteById(id) {
    const now = new Date();
    await Admin.deleteOne({ _id: id, ...tenantFilter() });
    await OrganizationMembership.updateOne(
      { ...tenantFilter(), userId: id, status: { $ne: "removed" } },
      { $set: { status: "removed", removedAt: now, updatedAt: now }, $inc: { version: 1 } },
    );
    await RefreshSession.updateMany(
      { userId: id, status: { $ne: "revoked" } },
      { $set: { status: "revoked", revokedAt: now, revokeReason: "admin_deleted" } },
    );
  },
};
