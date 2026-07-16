import Otp from "../../../../../modal/otpModel";
import type { OtpRepository } from "../../domain/ports/otpPorts";

export const mongoOtpRepository: OtpRepository = {
  async replace(email, purpose, code) {
    await Otp.deleteMany({ email, type: purpose });
    await Otp.create({ email, otp: code, type: purpose });
  },
  async findPending(email, purpose) {
    const record = await Otp.findOne({ email, type: purpose, verified: false }).lean();
    return record ? {
      id: String(record._id),
      code: record.otp,
      expiresAt: record.expiresAt,
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
};
