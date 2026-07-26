import mongoose, { Document, Schema } from "mongoose";

import { PUBLIC_GRANT_PURPOSES, type PublicGrantPurpose } from "../src/modules/publicAccess/domain/publicGrant";
export { PUBLIC_GRANT_PURPOSES, type PublicGrantPurpose } from "../src/modules/publicAccess/domain/publicGrant";

export interface IPublicAccessGrant extends Document {
  organizationId: mongoose.Types.ObjectId;
  resourceType: "proposal";
  resourceId: mongoose.Types.ObjectId;
  purpose: PublicGrantPurpose;
  tokenHash: string;
  createdByUserId: mongoose.Types.ObjectId;
  recipientHash?: string | null;
  policyVersion: string;
  expiresAt: Date;
  maxUses?: number | null;
  useCount: number;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const publicAccessGrantSchema = new Schema<IPublicAccessGrant>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    resourceType: { type: String, enum: ["proposal"], required: true },
    resourceId: { type: Schema.Types.ObjectId, ref: "Proposal", required: true },
    purpose: { type: String, enum: PUBLIC_GRANT_PURPOSES, required: true },
    tokenHash: { type: String, required: true, trim: true, unique: true, select: false },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recipientHash: { type: String, trim: true, default: null },
    policyVersion: { type: String, required: true, trim: true, default: "public-access.v1" },
    expiresAt: { type: Date, required: true },
    maxUses: { type: Number, min: 1, default: null },
    useCount: { type: Number, min: 0, default: 0 },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

publicAccessGrantSchema.index({ organizationId: 1, resourceId: 1, purpose: 1, revokedAt: 1 });
publicAccessGrantSchema.index({ expiresAt: 1 });

const PublicAccessGrant = mongoose.model<IPublicAccessGrant>(
  "PublicAccessGrant",
  publicAccessGrantSchema,
);
export default PublicAccessGrant;
