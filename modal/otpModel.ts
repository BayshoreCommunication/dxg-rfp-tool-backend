import mongoose, { Document, Schema } from "mongoose";

export interface IOtp extends Document {
  email: string;
  codeHash: string;
  type: "signup" | "forgot-password";
  expiresAt: Date;
  verified: boolean;
  attempts: number;
  maxAttempts: number;
}

const otpSchema = new Schema<IOtp>({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  codeHash: {
    type: String,
    required: true,
    select: false,
  },
  type: {
    type: String,
    enum: ["signup", "forgot-password"],
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
  },
  verified: {
    type: Boolean,
    default: false,
  },
  attempts: { type: Number, min: 0, default: 0 },
  maxAttempts: { type: Number, min: 1, default: 5 },
});

// Auto-delete expired OTPs via MongoDB TTL index
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ email: 1, type: 1 }, { unique: true });

const Otp = mongoose.model<IOtp>("Otp", otpSchema);
export default Otp;
