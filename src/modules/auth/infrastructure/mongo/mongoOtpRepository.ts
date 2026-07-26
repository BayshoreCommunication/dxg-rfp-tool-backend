import Otp from "../../../../../modal/otpModel";
import type { OtpRepository } from "../../domain/ports/otpPorts";

export const mongoOtpRepository: OtpRepository = {
  async replace(email, purpose, codeHash) {
    await Otp.findOneAndUpdate(
      { email, type: purpose },
      { $set: { codeHash, verified: false, attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 10 * 60 * 1000) } },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  },
  async findPending(email, purpose) {
    const record = await Otp.findOne({ email, type: purpose, verified: false }).select("+codeHash").lean();
    return record ? {
      id: String(record._id),
      codeHash: record.codeHash,
      expiresAt: record.expiresAt,
      attempts: record.attempts,
      maxAttempts: record.maxAttempts,
    } : null;
  },
  async markVerified(id) {
    await Otp.updateOne({ _id: id, verified: false }, { $set: { verified: true } });
  },
  async deleteById(id) {
    await Otp.deleteOne({ _id: id });
  },
  async deleteFor(email, purpose) {
    await Otp.deleteMany({ email, type: purpose });
  },
  async hasVerified(email, purpose) {
    return Boolean(await Otp.exists({ email, type: purpose, verified: true }));
  },
  async consumeVerified(email, purpose) {
    await Otp.deleteMany({ email, type: purpose, verified: true });
  },
  async recordFailedAttempt(id, maxAttempts) {
    const record = await Otp.findOneAndUpdate(
      { _id: id, verified: false, attempts: { $lt: maxAttempts } },
      { $inc: { attempts: 1 } },
      { new: true },
    ).select("attempts").lean();
    if (!record) return maxAttempts;
    if (record.attempts >= maxAttempts) await Otp.deleteOne({ _id: id });
    return record.attempts;
  },
};
