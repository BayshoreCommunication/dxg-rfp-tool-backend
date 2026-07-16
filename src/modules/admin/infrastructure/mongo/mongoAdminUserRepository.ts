import User from "../../../../../modal/userModel";
import type { AdminUserRepository } from "../../domain/ports/adminUserRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const safeUser = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

export const mongoAdminUserRepository: AdminUserRepository = {
  async list() {
    const users = await User.find({
      role: { $in: ["admin", "super_admin", "superadmin"] },
      ...tenantFilter(),
    }).select("-password").sort({ createdAt: -1 }).lean();
    return users.map(safeUser);
  },
  async emailExists(email) {
    return Boolean(await User.exists({ email, ...tenantFilter() }));
  },
  async findById(id) {
    const user = await User.findOne({ _id: id, ...tenantFilter() }).select("role").lean();
    return user ? { id: String(user._id), role: user.role, data: safeUser(user) } : null;
  },
  async create(input) {
    const created = await User.create({ ...input, ...tenantFilter() });
    const user = await User.findById(created._id).select("-password").lean();
    if (!user) throw new Error("Admin user disappeared after creation");
    return safeUser(user);
  },
  async update(id, patch) {
    const update: Record<string, unknown> = { ...patch };
    if (patch.passwordHash !== undefined) {
      update.password = patch.passwordHash;
      delete update.passwordHash;
    }
    const user = await User.findOneAndUpdate({ _id: id, ...tenantFilter() }, { $set: update }, {
      new: true,
      runValidators: false,
    }).select("-password").lean();
    if (!user) throw new Error("Admin user disappeared during update");
    return safeUser(user);
  },
  async deleteById(id) {
    await User.deleteOne({ _id: id, ...tenantFilter() });
  },
};
