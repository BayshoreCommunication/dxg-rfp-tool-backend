import mongoose, { Document, Schema } from "mongoose";

/* ORG-305: a domain an organization claims, and the state of proving it. Only a
   verified row counts; Organization.verifiedDomains mirrors the verified set for
   the signup lookup (ORG-306). One organization at most can hold a domain
   verified (partial unique index); any number may have it pending. */
export const DOMAIN_STATUSES = ["pending", "verified", "unverified"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const DOMAIN_VERIFICATION_METHODS = ["dns_txt", "admin_email"] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

export interface IOrganizationDomain extends Document {
  organizationId: mongoose.Types.ObjectId;
  domain: string;
  status: DomainStatus;
  verificationToken: string;
  method: DomainVerificationMethod | null;
  addedByUserId: mongoose.Types.ObjectId;
  verifiedByUserId: mongoose.Types.ObjectId | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckOutcome: string | null;
  nextCheckAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const organizationDomainSchema = new Schema<IOrganizationDomain>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    domain: { type: String, required: true, trim: true, lowercase: true },
    status: { type: String, enum: DOMAIN_STATUSES, required: true, default: "pending" },
    verificationToken: { type: String, required: true },
    method: { type: String, enum: [...DOMAIN_VERIFICATION_METHODS, null], default: null },
    addedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    verifiedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifiedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastCheckOutcome: { type: String, default: null },
    nextCheckAt: { type: Date, required: true },
  },
  { timestamps: true },
);

organizationDomainSchema.index({ organizationId: 1, domain: 1 }, { unique: true });
organizationDomainSchema.index(
  { domain: 1 },
  { unique: true, name: "one_verified_organization_per_domain", partialFilterExpression: { status: "verified" } },
);
organizationDomainSchema.index({ nextCheckAt: 1 });

const OrganizationDomain = mongoose.model<IOrganizationDomain>("OrganizationDomain", organizationDomainSchema);
export default OrganizationDomain;
