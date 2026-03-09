import mongoose, { Document } from "mongoose";
export interface IUser extends Document {
    name: string;
    email: string;
    password?: string;
    role: "customer" | "admin" | "staff" | "student" | "teacher";
    userType?: "main-user" | "sub-user";
    provider: "credentials" | "google" | "facebook" | "github";
    providerId?: string;
    avatar?: string;
    permissions?: string[];
    isEmailVerified: boolean;
    phone?: string;
    addresses?: Array<{
        fullName: string;
        phone: string;
        addressLine1: string;
        addressLine2?: string;
        city: string;
        state: string;
        zipCode: string;
        country: string;
        isDefault: boolean;
    }>;
    wishlist?: mongoose.Types.ObjectId[];
    totalOrders: number;
    totalSpent: number;
    lastOrderDate?: Date;
    createdAt: Date;
    updatedAt: Date;
    comparePassword(candidatePassword: string): Promise<boolean>;
}
declare const User: mongoose.Model<IUser, {}, {}, {}, mongoose.Document<unknown, {}, IUser, {}, {}> & IUser & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default User;
//# sourceMappingURL=user.d.ts.map