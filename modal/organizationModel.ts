import mongoose, { Document, Schema } from "mongoose";

export const ORGANIZATION_TYPES = ["corporate", "association", "agency", "venue", "government", "other"] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

// legacy_holding keeps one pre-organization user's data apart until a DXG admin places them.
export const ORGANIZATION_KINDS = ["customer", "legacy_holding"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

// Pricing is by proposals created. Paid plans join this list once DXG defines them.
export const ORGANIZATION_PLANS = ["free_trial"] as const;
export type OrganizationPlan = (typeof ORGANIZATION_PLANS)[number];

export const BILLING_STATUSES = ["none", "active", "past_due", "canceled"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export interface IOrganization extends Document {
  name: string;
  slug: string;
  status: "active" | "inactive";
  kind: OrganizationKind;
  type: OrganizationType | null;
  industry: string | null;
  country: string | null;
  timeZone: string | null;
  eventsPerYear: number | null;
  plan: OrganizationPlan;
  billingStatus: BillingStatus;
  proposalsCreated: number;
  verifiedDomains: string[];
  autoApproveDomain: boolean;
  requireTwoFactor: boolean;
  requireSso: boolean;
  allowManagerInvites: boolean;
  /** Created at a Google or Microsoft sign-up with no company given; the Owner is asked to name it. */
  needsName: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid organization slug"],
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    kind: { type: String, enum: ORGANIZATION_KINDS, default: "customer", required: true },
    type: { type: String, enum: [...ORGANIZATION_TYPES, null], default: null },
    industry: { type: String, trim: true, maxlength: 120, default: null },
    country: { type: String, trim: true, uppercase: true, match: [/^[A-Z]{2}$/, "Invalid ISO country code"], default: null },
    timeZone: {
      type: String,
      trim: true,
      default: null,
      validate: { validator: (value: string | null) => value === null || isIanaTimeZone(value), message: "Invalid IANA time zone" },
    },
    eventsPerYear: { type: Number, min: 0, max: 100_000, default: null },
    plan: { type: String, enum: ORGANIZATION_PLANS, default: "free_trial", required: true },
    billingStatus: { type: String, enum: BILLING_STATUSES, default: "none", required: true },
    // Only ever incremented with proposal creation; deleting a proposal never frees a slot.
    proposalsCreated: { type: Number, min: 0, default: 0, required: true },
    verifiedDomains: {
      type: [{ type: String, trim: true, lowercase: true, match: [DOMAIN_PATTERN, "Invalid domain"] }],
      default: [],
    },
    autoApproveDomain: { type: Boolean, default: false },
    requireTwoFactor: { type: Boolean, default: false },
    // Members whose email is on the SSO connection's domains must use it (the Owner is exempt).
    requireSso: { type: Boolean, default: false },
    allowManagerInvites: { type: Boolean, default: false },
    needsName: { type: Boolean, default: false },
  },
  { timestamps: true },
);

organizationSchema.path("verifiedDomains").validate(
  (domains: string[]) => new Set(domains).size === domains.length,
  "Verified domains must be unique",
);
organizationSchema.index({ verifiedDomains: 1 });

const Organization = mongoose.model<IOrganization>("Organization", organizationSchema);
export default Organization;
