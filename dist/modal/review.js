"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const reviewSchema = new mongoose_1.Schema({
    product: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Product",
        required: [true, "Product is required"],
    },
    customer: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
        required: [true, "Customer is required"],
    },
    customerName: {
        type: String,
        required: true,
    },
    order: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Order",
    },
    rating: {
        type: Number,
        required: [true, "Rating is required"],
        min: [1, "Rating must be at least 1"],
        max: [5, "Rating cannot exceed 5"],
    },
    title: {
        type: String,
        maxlength: [200, "Title cannot exceed 200 characters"],
    },
    comment: {
        type: String,
        required: [true, "Comment is required"],
        maxlength: [2000, "Comment cannot exceed 2000 characters"],
    },
    images: [{ type: String }],
    helpful: {
        type: Number,
        default: 0,
    },
    notHelpful: {
        type: Number,
        default: 0,
    },
    isVerifiedPurchase: {
        type: Boolean,
        default: false,
    },
    status: {
        type: String,
        enum: ["pending", "approved", "rejected"],
        default: "pending",
    },
    response: {
        text: { type: String },
        respondedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: "User" },
        respondedAt: { type: Date },
    },
}, {
    timestamps: true,
});
// Indexes
reviewSchema.index({ product: 1, status: 1 });
reviewSchema.index({ customer: 1 });
reviewSchema.index({ rating: -1 });
reviewSchema.index({ createdAt: -1 });
// Prevent duplicate reviews from same customer for same product
reviewSchema.index({ product: 1, customer: 1 }, { unique: true });
// Update product rating after review is saved
reviewSchema.post("save", async function () {
    if (this.status === "approved") {
        const Product = mongoose_1.default.model("Product");
        const reviews = await mongoose_1.default.model("Review").find({
            product: this.product,
            status: "approved",
        });
        const totalReviews = reviews.length;
        const averageRating = reviews.reduce((sum, review) => sum + review.rating, 0) / totalReviews;
        await Product.findByIdAndUpdate(this.product, {
            averageRating: Math.round(averageRating * 10) / 10,
            totalReviews,
        });
    }
});
reviewSchema.set("toJSON", { virtuals: true });
reviewSchema.set("toObject", { virtuals: true });
const Review = mongoose_1.default.models.Review || mongoose_1.default.model("Review", reviewSchema);
exports.default = Review;
//# sourceMappingURL=review.js.map