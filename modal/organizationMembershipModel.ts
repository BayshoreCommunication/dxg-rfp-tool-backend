import mongoose, { Document, Schema } from "mongoose";

export const ORGANIZATION_ROLES = [
  "planner",
  "organization_admin",
  "dxg_producer",
  "knowledge_editor",
  "knowledge_approver",
  "dxg_admin",
  "super_admin",
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export interface IOrganizationMembership extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  roles: OrganizationRole[];
  status: "invited" | "active" | "suspended" | "removed";
  version: number;
  invitedAt?: Date | null;
  activatedAt?: Date | null;
  suspendedAt?: Date | null;
  removedAt?: Date | null;
  migrationRunId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const organizationMembershipSchema = new Schema<IOrganizationMembership>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    roles: [{ type: String, enum: ORGANIZATION_ROLES, required: true }],
    status: {
      type: String,
      enum: ["invited", "active", "suspended", "removed"],
      default: "active",
      required: true,
    },
    version: { type: Number, min: 1, default: 1, required: true },
    invitedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
    migrationRunId: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

organizationMembershipSchema.path("roles").validate(
  (roles: OrganizationRole[]) => roles.length > 0 && new Set(roles).size === roles.length,
  "At least one unique organization role is required",
);
organizationMembershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
organizationMembershipSchema.index({ organizationId: 1, status: 1, roles: 1 });

const OrganizationMembership = mongoose.model<IOrganizationMembership>(
  "OrganizationMembership",
  organizationMembershipSchema,
);
export default OrganizationMembership;
