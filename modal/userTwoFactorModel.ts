import mongoose, { Document, Schema } from "mongoose";

/* One row per user with TOTP enrolled or being enrolled (ORG-303). The seed is
   sealed with the secret box (AES-256-GCM, bound to the user id) and recovery
   codes are HMAC hashes, so a database read reveals neither. Disabling or an
   Admin reset deletes the row. */
export interface IUserTwoFactor extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  status: "pending" | "enabled";
  secretCiphertext: string;
  // The highest TOTP step ever accepted. A code at or below it is a replay.
  lastUsedStep: number;
  recoveryCodes: Array<{ hash: string; usedAt: Date | null }>;
  failedAttempts: number;
  lockedUntil: Date | null;
  enabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userTwoFactorSchema = new Schema<IUserTwoFactor>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    status: { type: String, enum: ["pending", "enabled"], required: true, default: "pending" },
    secretCiphertext: { type: String, required: true, select: false },
    lastUsedStep: { type: Number, required: true, default: -1 },
    recoveryCodes: {
      type: [new Schema({ hash: { type: String, required: true }, usedAt: { type: Date, default: null } }, { _id: false })],
      default: [],
      select: false,
    },
    failedAttempts: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, default: null },
    enabledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const UserTwoFactor = mongoose.model<IUserTwoFactor>("UserTwoFactor", userTwoFactorSchema);
export default UserTwoFactor;
