import mongoose, { Document, Schema } from "mongoose";

export const CUSTOMER_ORGANIZATION_ROLES = [
  "owner",
  "organization_admin",
  "team_manager",
  "planner",
  "viewer",
] as const;
// DXG staff live in the admins collection. These values stay readable on existing
// memberships so the tenancy migration can strip them; new writes refuse them.
export const LEGACY_DXG_ROLES = ["dxg_producer", "dxg_admin", "super_admin"] as const;
export const ORGANIZATION_ROLES = [
  ...CUSTOMER_ORGANIZATION_ROLES,
  "knowledge_editor",
  "knowledge_approver",
  ...LEGACY_DXG_ROLES,
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const isLegacyDxgRole = (role: string): boolean => (LEGACY_DXG_ROLES as readonly string[]).includes(role);

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
  // Set at each sign-in (ORG-206 member list). Not part of the optimistic version.
  lastSignedInAt?: Date | null;
  // ORG-505: the first time this member opened an RFP here (launch metric). Set once.
  firstRfpOpenedAt?: Date | null;
  // ORG-307: set when someone else changed this member's role. The member's next request claims
  // it, keeps that session and revokes their other sessions.
  sessionRevocationPending?: boolean;
  // The request currently revoking for the pending flag; the flag clears only after it succeeds.
  sessionRevocationClaim?: { sessionId: string; at: Date } | null;
  // Staff member management (owner decision, 2026-11-18). Internal markers, never returned by an
  // API: both name the RFPilot staff organization and account whose change caused a session
  // revocation, so the revocation is recorded there and not in this organization's audit trail.
  // sessionRevocationStaff: set with the pending flag by a staff role change; cleared when the
  // flag is completed or a member of the organization sets it again.
  sessionRevocationStaff?: { organizationId?: string | null; actorUserId?: string | null } | null;
  // suspendedByStaff: set in the transaction of a staff deactivation; cleared by any later
  // deactivation or reactivation.
  suspendedByStaff?: { organizationId?: string | null; actorUserId?: string | null } | null;
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
    lastSignedInAt: { type: Date, default: null },
    firstRfpOpenedAt: { type: Date, default: null },
    sessionRevocationPending: { type: Boolean, default: false },
    sessionRevocationClaim: { type: new Schema({ sessionId: String, at: Date }, { _id: false }), default: null },
    sessionRevocationStaff: { type: new Schema({ organizationId: String, actorUserId: String }, { _id: false }) },
    suspendedByStaff: { type: new Schema({ organizationId: String, actorUserId: String }, { _id: false }) },
    migrationRunId: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

organizationMembershipSchema.path("roles").validate(
  (roles: OrganizationRole[]) => roles.length > 0 && new Set(roles).size === roles.length,
  "At least one unique organization role is required",
);
// Runs for documents and for updates with runValidators. DXG staff sign-in still upserts
// dxg_admin/super_admin memberships in DXG's own organization (never a customer one) without
// validators; that ends when the admin app stops authenticating through memberships.
organizationMembershipSchema.path("roles").validate({
  validator(this: unknown, roles: OrganizationRole[]) {
    const isUnchangedDocument =
      this instanceof mongoose.Document && !this.isNew && !this.isModified("roles");
    return isUnchangedDocument || !roles.some(isLegacyDxgRole);
  },
  message: (props: { value: OrganizationRole[] }) =>
    `Legacy DXG roles cannot be granted: ${props.value.filter(isLegacyDxgRole).join(", ")}`,
});
organizationMembershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
organizationMembershipSchema.index({ organizationId: 1, status: 1, roles: 1 });
organizationMembershipSchema.index(
  { organizationId: 1 },
  { unique: true, name: "one_active_owner_per_organization", partialFilterExpression: { status: "active", roles: "owner" } },
);

const OrganizationMembership = mongoose.model<IOrganizationMembership>(
  "OrganizationMembership",
  organizationMembershipSchema,
);
export default OrganizationMembership;
