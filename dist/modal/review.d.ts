import mongoose, { Document } from "mongoose";
export interface IReview extends Document {
    product: mongoose.Types.ObjectId;
    customer: mongoose.Types.ObjectId;
    customerName: string;
    order: mongoose.Types.ObjectId;
    rating: number;
    title?: string;
    comment: string;
    images?: string[];
    helpful: number;
    notHelpful: number;
    isVerifiedPurchase: boolean;
    status: "pending" | "approved" | "rejected";
    response?: {
        text: string;
        respondedBy: mongoose.Types.ObjectId;
        respondedAt: Date;
    };
    createdAt: Date;
    updatedAt: Date;
}
declare const Review: mongoose.Model<any, {}, {}, {}, any, any>;
export default Review;
//# sourceMappingURL=review.d.ts.map