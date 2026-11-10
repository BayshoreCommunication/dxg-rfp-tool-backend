import mongoose, { Document, Schema } from "mongoose";

// ORG-606: one entry on an organization's shared vendor list (DXG decision Q4). Members pick
// from it when sending an RFP. It is never reachable through a vendor's submission link.
export interface IOrganizationVendorContact {
  name: string;
  email: string;
}

export interface IOrganizationVendor extends Document {
  organizationId: mongoose.Types.ObjectId;
  company: string;
  category: string;
  contacts: IOrganizationVendorContact[];
  addedBy?: mongoose.Types.ObjectId | null;
  // An archived vendor leaves the picker but keeps its contacts, so it can be restored.
  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new Schema<IOrganizationVendorContact>(
  {
    name: { type: String, trim: true, maxlength: 120, default: "" },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  },
  { _id: false },
);

const organizationVendorSchema = new Schema<IOrganizationVendor>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    company: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    category: { type: String, trim: true, maxlength: 80, default: "" },
    contacts: { type: [contactSchema], default: [], validate: [(value: unknown[]) => value.length <= 50, "A vendor can have at most 50 contacts"] },
    addedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archived: { type: Boolean, default: false, required: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Active company names are unique per organization, ignoring case. Archived names can be reused.
organizationVendorSchema.index(
  { organizationId: 1, company: 1 },
  {
    unique: true,
    name: "active_vendor_company_per_organization",
    partialFilterExpression: { archived: false },
    collation: { locale: "en", strength: 2 },
  },
);
organizationVendorSchema.index({ organizationId: 1, archived: 1, category: 1 });

const OrganizationVendor = mongoose.model<IOrganizationVendor>("OrganizationVendor", organizationVendorSchema);
export default OrganizationVendor;
