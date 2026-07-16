import mongoose, { Document, Schema } from "mongoose";

export interface ISecurityAuditEvent extends Document {
  organizationId?: mongoose.Types.ObjectId | null;
  actorUserId?: mongoose.Types.ObjectId | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  decision: "allowed" | "denied" | "created" | "revoked" | "detected";
  reason: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const securityAuditEventSchema = new Schema<ISecurityAuditEvent>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, trim: true },
    targetType: { type: String, required: true, trim: true },
    targetId: { type: String, trim: true, default: null },
    decision: {
      type: String,
      enum: ["allowed", "denied", "created", "revoked", "detected"],
      required: true,
    },
    reason: { type: String, required: true, trim: true },
    correlationId: { type: String, required: true, trim: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false },
  },
);

securityAuditEventSchema.index({ organizationId: 1, createdAt: -1 });
securityAuditEventSchema.index({ actorUserId: 1, createdAt: -1 });
securityAuditEventSchema.index({ correlationId: 1 });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany"] as const) {
  securityAuditEventSchema.pre(operation, function appendOnly() {
    throw new Error("Security audit events are append-only");
  });
}

const SecurityAuditEvent = mongoose.model<ISecurityAuditEvent>(
  "SecurityAuditEvent",
  securityAuditEventSchema,
);
export default SecurityAuditEvent;
