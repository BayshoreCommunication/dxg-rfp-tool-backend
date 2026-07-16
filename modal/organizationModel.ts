import mongoose, { Document, Schema } from "mongoose";

export interface IOrganization extends Document {
  name: string;
  slug: string;
  status: "active" | "inactive";
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
  },
  { timestamps: true },
);

const Organization = mongoose.model<IOrganization>("Organization", organizationSchema);
export default Organization;
