import Admin from "../../../../../modal/adminModel";
import type { AdminSelfProfileRepository } from "../../domain/ports/adminSelfProfilePorts";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const safeData = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export const mongoAdminSelfProfileRepository: AdminSelfProfileRepository = {
  async findSafe(userId) {
    const admin = await Admin.findOne({ _id: userId, ...tenantFilter() }).select("-password").lean();
    return admin ? safeData(admin) : null;
  },
  async findCredentials(userId) {
    const admin = await Admin.findOne({ _id: userId, ...tenantFilter() }).select("+password").lean();
    return admin?.password ? { passwordHash: admin.password } : null;
  },
  async update(userId, patch) {
    const update: Record<string, unknown> = { ...patch };
    if (patch.passwordHash !== undefined) {
      update.password = patch.passwordHash;
      delete update.passwordHash;
    }
    const admin = await Admin.findOneAndUpdate(
      { _id: userId, ...tenantFilter() },
      { $set: update },
      { new: true, runValidators: true },
    ).select("-password").lean();
    if (!admin) throw new Error("Admin profile disappeared during update");
    return safeData(admin);
  },
};
