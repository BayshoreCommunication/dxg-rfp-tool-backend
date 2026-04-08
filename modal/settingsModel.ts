import mongoose, { Document, Schema } from "mongoose";

export interface ISettings extends Document {
  userId?: mongoose.Types.ObjectId;
  branding: {
    brandName: string;
    linkPrefix: string;
    defaultFont: string;
    signatureColor: string;
    logoFile: string | null;
  };
  proposals: {
    proposalLanguage: string;
    defaultCurrency: string;
    expiryDate: string;
    priceSeparator: string;
    dateFormat: string;
    decimalPrecision: string;
    contacts: {
      email: { enabled: boolean; value: string };
      call: { enabled: boolean; value: string };
    };
    downloadPreview: string;
    teammateEmail: string;
  };
  signatures: {
    signatureType: string;      // "Upload" | "Draw"
    signatureImageUrl: string;  // used when type = "Upload"
    signatureText: string;      // used when type = "Draw"
    signatureStyle: string;     // used when type = "Draw" (font family)
  };
  createdAt: Date;
  updatedAt: Date;
}

const settingsSchema = new Schema<ISettings>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    branding: {
      brandName: { type: String, default: "", trim: true },
      linkPrefix: { type: String, default: "", trim: true },
      defaultFont: { type: String, default: "Poppins", trim: true },
      signatureColor: { type: String, default: "#2DC6F5", trim: true },
      logoFile: { type: String, default: null },
    },
    proposals: {
      proposalLanguage: { type: String, default: "English", trim: true },
      defaultCurrency: { type: String, default: "$", trim: true },
      expiryDate: { type: String, default: "None", trim: true },
      priceSeparator: { type: String, default: "NONE", trim: true },
      dateFormat: { type: String, default: "MM/DD/YYYY", trim: true },
      decimalPrecision: { type: String, default: "2", trim: true },
      contacts: {
        email: {
          enabled: { type: Boolean, default: true },
          value: { type: String, default: "", trim: true },
        },
        call: {
          enabled: { type: Boolean, default: false },
          value: { type: String, default: "", trim: true },
        },
      },
      downloadPreview: { type: String, default: "Yes", trim: true },
      teammateEmail: { type: String, default: "", trim: true },
    },
    signatures: {
      signatureType: { type: String, default: "Upload", trim: true },
      signatureImageUrl: { type: String, default: "", trim: true },
      signatureText: { type: String, default: "", trim: true },
      signatureStyle: { type: String, default: "", trim: true },
    },
  },
  { timestamps: true }
);

settingsSchema.index({ userId: 1 });

const Settings = mongoose.model<ISettings>("Settings", settingsSchema);

export default Settings;
