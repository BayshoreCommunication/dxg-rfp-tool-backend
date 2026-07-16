import User from "../../../../../modal/userModel";
import type { UserAccountRepository } from "../../domain/ports/userAccountRepository";
import { tenantFilter } from "../../../shared/tenancy/tenantContext";

const safeData = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const toAccount = (user: { _id: unknown; email: string; role?: string } & Record<string, unknown>) => ({
  id: String(user._id),
  email: user.email,
  role: user.role,
  data: safeData(user),
});

export const mongoUserAccountRepository: UserAccountRepository = {
  async list() {
    const users = await User.find(tenantFilter()).select("-password").sort({ createdAt: -1 }).lean();
    return users.map(safeData);
  },
  async findById(id) {
    const user = await User.findOne({ _id: id, ...tenantFilter() }).select("-password").lean();
    return user ? toAccount(user as typeof user & { email: string }) : null;
  },
  async findPrimaryAdmin(configuredEmail) {
    const user = configuredEmail
      ? await User.findOne({ email: configuredEmail, ...tenantFilter() }).select("-password").lean()
      : await User.findOne(tenantFilter()).sort({ createdAt: 1 }).select("-password").lean();
    const fallback = user ?? (configuredEmail
      ? await User.findOne(tenantFilter()).sort({ createdAt: 1 }).select("-password").lean()
      : null);
    return fallback ? toAccount(fallback as typeof fallback & { email: string }) : null;
  },
  async emailBelongsToOther(email, userId) {
    return Boolean(await User.exists({ email, _id: { $ne: userId }, ...tenantFilter() }));
  },
  async update(id, patch) {
    const update: Record<string, unknown> = { ...patch };
    if (patch.passwordHash !== undefined) {
      update.password = patch.passwordHash;
      delete update.passwordHash;
    }
    const user = await User.findOneAndUpdate({ _id: id, ...tenantFilter() }, { $set: update }, {
      new: true,
      runValidators: true,
    }).select("-password").lean();
    if (!user) throw new Error("User disappeared during update");
    return safeData(user);
  },
  async deleteById(id) {
    return Boolean(await User.findOneAndDelete({ _id: id, ...tenantFilter() }));
  },
};
