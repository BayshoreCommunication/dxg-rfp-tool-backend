import bcrypt from "bcryptjs";
import mongoose, { Document, Schema } from "mongoose";

/* A Microsoft or company-OIDC identity linked to this account. `issuer` + `subject` is
   the provider's stable id for the person (Microsoft: tenant id + object id), so a
   later sign-in matches on it rather than on an email that the IdP could change. */
export type FederatedIdentity = {
  provider: "microsoft" | "company_oidc";
  issuer: string;
  subject: string;
  linkedAt: Date;
};

export interface IUser extends Document {
  organizationId?: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  password?: string;
  avatar?: string;
  googleId?: string;
  federatedIdentities?: FederatedIdentity[];
  company?: string;
  role?: "customer" | "admin" | "super_admin" | "superadmin";
  isBlocked?: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    phone: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false, // Don't return password by default
    },
    avatar: {
      type: String,
    },
    googleId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    federatedIdentities: {
      type: [
        {
          _id: false,
          provider: { type: String, enum: ["microsoft", "company_oidc"], required: true },
          issuer: { type: String, required: true },
          subject: { type: String, required: true },
          linkedAt: { type: Date, required: true },
        },
      ],
      default: undefined,
    },
    company: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ["customer", "admin", "super_admin", "superadmin"],
      default: "customer",
      trim: true,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.index({ organizationId: 1, email: 1 });
userSchema.index(
  { "federatedIdentities.issuer": 1, "federatedIdentities.subject": 1 },
  { unique: true, partialFilterExpression: { "federatedIdentities.subject": { $exists: true } } },
);

// Compare password method
userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  if (!this.password) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model<IUser>("User", userSchema);

export default User;
