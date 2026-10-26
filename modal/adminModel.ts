import bcrypt from "bcryptjs";
import mongoose, { Document, Schema } from "mongoose";

/* Back-office administrators live apart from planner accounts in `users`, so
   one email can hold a planner account and an admin account independently.
   Ids never collide across the two collections (both are ObjectIds), which is
   what lets sessions, memberships and audit rows keep a single userId field. */
export const ADMIN_ACCOUNT_ROLES = ["admin", "super_admin", "superadmin"] as const;
export type AdminAccountRole = (typeof ADMIN_ACCOUNT_ROLES)[number];

export interface IAdmin extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  email: string;
  phone?: string;
  password?: string;
  avatar?: string;
  role: AdminAccountRole;
  isBlocked?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const adminSchema = new Schema<IAdmin>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
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
      select: false,
    },
    avatar: {
      type: String,
    },
    role: {
      type: String,
      enum: ADMIN_ACCOUNT_ROLES,
      default: "admin",
      trim: true,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    collection: "admins",
  }
);

// Same contract as the User model: a plain password set through save() is
// hashed; already-hashed values written with update operators are left alone.
adminSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

adminSchema.index({ organizationId: 1, email: 1 });

const Admin = mongoose.model<IAdmin>("Admin", adminSchema);

export default Admin;
