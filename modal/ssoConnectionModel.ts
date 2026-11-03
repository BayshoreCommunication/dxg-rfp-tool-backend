import mongoose, { Document, Schema } from "mongoose";

/* An organization's own OpenID Connect identity provider (Okta, Entra tenant, Google
   Workspace, ...). One per organization. It may only sign in emails on `domains`, and
   every one of those must be verified by the organization (ORG-305), so a connection
   can never vouch for someone else's address. The client secret is sealed with
   SSO_SECRET_KEY and bound to the organization id, and is never returned by the API. */
export const SSO_CONNECTION_STATUSES = ["draft", "active"] as const;
export type SsoConnectionStatus = (typeof SSO_CONNECTION_STATUSES)[number];

export interface ISsoConnection extends Document {
  organizationId: mongoose.Types.ObjectId;
  issuer: string;
  clientId: string;
  clientSecretSealed: string;
  domains: string[];
  status: SsoConnectionStatus;
  lastTestedAt: Date | null;
  lastTestOutcome: string | null;
  version: number;
  updatedByUserId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ssoConnectionSchema = new Schema<ISsoConnection>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    issuer: { type: String, required: true, trim: true },
    clientId: { type: String, required: true, trim: true },
    clientSecretSealed: { type: String, required: true },
    domains: { type: [String], default: [] },
    status: { type: String, enum: SSO_CONNECTION_STATUSES, required: true, default: "draft" },
    lastTestedAt: { type: Date, default: null },
    lastTestOutcome: { type: String, default: null },
    version: { type: Number, required: true, default: 1 },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

ssoConnectionSchema.index({ organizationId: 1 }, { unique: true });
// Sign-in looks a connection up by the email's domain.
ssoConnectionSchema.index({ domains: 1, status: 1 });

const SsoConnection = mongoose.model<ISsoConnection>("SsoConnection", ssoConnectionSchema);
export default SsoConnection;
