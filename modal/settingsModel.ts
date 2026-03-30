import mongoose, { Document, Schema } from "mongoose";

export interface ISettings extends Document {
  userId?: mongoose.Types.ObjectId;
  branding: {
    brandName: string;
    linkPrefix: string;
    defaultFont: string;
    signatureColor: string;
    buttonTextColor: string;
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
      whatsapp: { enabled: boolean; value: string };
    };
    redirectUrl: string;
    redirectDelay: string;
    downloadPreviewTop: string;
    teammateEmail: string;
    downloadPreviewBottom: string;
    enableAiAssistant: boolean;
  };
  signatures: {
    signatureType: string;
    prospectOptions: string[];
    signatureText: string;
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
      brandName: { type: String, default: "Abuco", trim: true },
      linkPrefix: { type: String, default: "abuco", trim: true },
      defaultFont: { type: String, default: "Poppins", trim: true },
      signatureColor: { type: String, default: "#2DC6F5", trim: true },
      buttonTextColor: { type: String, default: "#FFFFFF", trim: true },
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
          value: { type: String, default: "ui.abukawsar@gmail.com", trim: true },
        },
        call: {
          enabled: { type: Boolean, default: false },
          value: { type: String, default: "+12163547758", trim: true },
        },
        whatsapp: {
          enabled: { type: Boolean, default: false },
          value: { type: String, default: "+12163547758", trim: true },
        },
      },
      redirectUrl: { type: String, default: "", trim: true },
      redirectDelay: { type: String, default: "0", trim: true },
      downloadPreviewTop: { type: String, default: "Yes", trim: true },
      teammateEmail: { type: String, default: "", trim: true },
      downloadPreviewBottom: { type: String, default: "Yes", trim: true },
      enableAiAssistant: { type: Boolean, default: true },
    },
    signatures: {
      signatureType: { type: String, default: "Type", trim: true },
      prospectOptions: {
        type: [String],
        default: ["Type", "Upload", "Draw"],
      },
      signatureText: { type: String, default: "ui.abukawsar", trim: true },
    },
  },
  { timestamps: true }
);

settingsSchema.index({ userId: 1 });

const Settings = mongoose.model<ISettings>("Settings", settingsSchema);

export default Settings;
