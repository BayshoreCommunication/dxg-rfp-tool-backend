import mongoose, { Document, Schema } from "mongoose";

export interface IRefreshSession extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  sessionId: string;
  familyId: string;
  tokenId: string;
  tokenHash: string;
  parentTokenId?: string | null;
  status: "active" | "consumed" | "revoked";
  expiresAt: Date;
  idleExpiresAt: Date;
  lastUsedAt: Date;
  consumedAt?: Date | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  userAgentHash?: string | null;
  ipHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const refreshSessionSchema = new Schema<IRefreshSession>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: { type: String, required: true, trim: true },
    familyId: { type: String, required: true, trim: true },
    tokenId: { type: String, required: true, trim: true, unique: true },
    tokenHash: { type: String, required: true, trim: true, unique: true, select: false },
    parentTokenId: { type: String, trim: true, default: null },
    status: {
      type: String,
      enum: ["active", "consumed", "revoked"],
      required: true,
      default: "active",
    },
    expiresAt: { type: Date, required: true },
    idleExpiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, default: null },
    userAgentHash: { type: String, trim: true, default: null },
    ipHash: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

refreshSessionSchema.index({ familyId: 1, status: 1 });
refreshSessionSchema.index({ organizationId: 1, userId: 1, sessionId: 1 });
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshSession = mongoose.model<IRefreshSession>("RefreshSession", refreshSessionSchema);
export default RefreshSession;
