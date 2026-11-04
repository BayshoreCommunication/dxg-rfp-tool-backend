import mongoose, { Document, Schema } from "mongoose";

/* The short-lived step between a correct password (or SSO) and a session
   (ORG-303/304). The client holds an opaque token; only its hash is stored. It
   grants nothing but the second-factor endpoints, is single-use, allows a few
   attempts, and Mongo's TTL index removes it after it expires. */
export interface ITwoFactorChallenge extends Document {
  tokenHash: string;
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  purpose: "verify" | "enrol";
  method: "password" | "sso";
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

const twoFactorChallengeSchema = new Schema<ITwoFactorChallenge>(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    purpose: { type: String, enum: ["verify", "enrol"], required: true },
    method: { type: String, enum: ["password", "sso"], required: true },
    attempts: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

twoFactorChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const TwoFactorChallenge = mongoose.model<ITwoFactorChallenge>("TwoFactorChallenge", twoFactorChallengeSchema);
export default TwoFactorChallenge;
