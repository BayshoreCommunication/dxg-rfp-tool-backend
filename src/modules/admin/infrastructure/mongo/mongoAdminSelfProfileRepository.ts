import User from "../../../../../modal/userModel";
import type { AdminSelfProfileRepository } from "../../domain/ports/adminSelfProfilePorts";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const safeData = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export const mongoAdminSelfProfileRepository: AdminSelfProfileRepository = {
  async findSafe(userId) {
    const user = await User.findOne({ _id: userId, ...tenantFilter() }).select("-password").lean();
    return user ? safeData(user) : null;
  },
  async findCredentials(userId) {
    const user = await User.findOne({ _id: userId, ...tenantFilter() }).select("+password").lean();
    return user?.password ? { passwordHash: user.password } : null;
  },
  async update(userId, patch) {
    const update: Record<string, unknown> = { ...patch };
    if (patch.passwordHash !== undefined) {
      update.password = patch.passwordHash;
      delete update.passwordHash;
    }
    const user = await User.findOneAndUpdate(
      { _id: userId, ...tenantFilter() },
      { $set: update },
      { new: true, runValidators: true },
    ).select("-password").lean();
    if (!user) throw new Error("Admin profile disappeared during update");
    return safeData(user);
  },
};
