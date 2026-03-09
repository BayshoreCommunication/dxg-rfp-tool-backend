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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.replyToReview = exports.deleteReview = exports.updateReviewStatus = exports.createReview = exports.getReviews = void 0;
const order_1 = __importDefault(require("../modal/order"));
// Product is dynamically imported to avoid circular dependency issues if any
const review_1 = __importDefault(require("../modal/review"));
const customer_1 = __importDefault(require("../modal/customer"));
const user_1 = __importDefault(require("../modal/user")); // Import User to fetch name (dashboard users)
// Get reviews (Public/Admin)
const getReviews = async (req, res) => {
    try {
        const { page = 1, limit = 20, product, customer, status, rating, sortBy = "createdAt", sortOrder = "desc", } = req.query;
        const query = {};
        if (product)
            query.product = product;
        // Handle "me" as a special value for authenticated users
        if (customer === "me") {
            const authReq = req;
            // Try to get user from token if provided
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                try {
                    const { verifyAccessToken } = await Promise.resolve().then(() => __importStar(require("../config/jwt")));
                    const token = authHeader.substring(7);
                    const decoded = verifyAccessToken(token);
                    query.customer = decoded.userId;
                }
                catch (error) {
                    return res.status(401).json({
                        success: false,
                        message: "Invalid token for 'me' query",
                    });
                }
            }
            else {
                return res.status(401).json({
                    success: false,
                    message: "Authentication required for 'me' query",
                });
            }
        }
        else if (customer) {
            query.customer = customer;
        }
        if (status)
            query.status = status;
        if (rating)
            query.rating = rating;
        const skip = (Number(page) - 1) * Number(limit);
        const sort = {};
        sort[sortBy] = sortOrder === "asc" ? 1 : -1;
        const reviews = await review_1.default.find(query)
            .populate("customer", "name avatar")
            .populate("product", "name slug images")
            .sort(sort)
            .limit(Number(limit))
            .skip(skip);
        const total = await review_1.default.countDocuments(query);
        res.status(200).json({
            success: true,
            data: reviews,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                pages: Math.ceil(total / Number(limit)),
            },
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            message: "Error fetching reviews",
            error: error.message,
        });
    }
};
exports.getReviews = getReviews;
// Create review (Customer)
const createReview = async (req, res) => {
    try {
        const { product: productId, order: orderId, rating, comment, title, images } = req.body;
        const userId = req.user?.userId;
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated",
            });
        }
        // Fetch customer/user to get name (support both website customers and dashboard users)
        let userName = "Customer";
        const customer = await customer_1.default.findById(userId);
        if (customer) {
            userName = customer.name;
        }
        else {
            const user = await user_1.default.findById(userId);
            if (user?.name) {
                userName = user.name;
            }
        }
        // 1. Verify Order
        const order = await order_1.default.findOne({
            _id: orderId,
            customer: userId,
            orderStatus: "delivered", // Must be delivered
        });
        if (!order) {
            return res.status(400).json({
                success: false,
                message: "Order not found or not delivered yet. You can only review products from delivered orders.",
            });
        }
        // 2. Verify Product is in Order
        const hasProduct = order.items.some((item) => item.product.toString() === productId);
        if (!hasProduct) {
            return res.status(400).json({
                success: false,
                message: "This product was not found in the specified order.",
            });
        }
        // 3. Check for existing review
        const existingReview = await review_1.default.findOne({
            product: productId,
            customer: userId,
        });
        if (existingReview) {
            return res.status(400).json({
                success: false,
                message: "You have already reviewed this product.",
            });
        }
        // 4. Create Review
        const review = await review_1.default.create({
            product: productId,
            customer: userId,
            customerName: userName,
            order: orderId,
            rating,
            title,
            comment,
            images,
            isVerifiedPurchase: true,
            status: "pending", // Default to pending for moderation
        });
        return res.status(201).json({
            success: true,
            message: "Review submitted successfully! It is pending approval.",
            data: review,
        });
    }
    catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "You have already reviewed this product.",
            });
        }
        return res.status(500).json({
            success: false,
            message: "Error creating review",
            error: error.message,
        });
    }
};
exports.createReview = createReview;
// Update review status (Admin)
const updateReviewStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const review = await review_1.default.findById(id);
        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found",
            });
        }
        review.status = status;
        await review.save(); // Triggers post-save hook to update product rating
        return res.status(200).json({
            success: true,
            message: `Review ${status} successfully`,
            data: review,
        });
    }
    catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error updating review status",
            error: error.message,
        });
    }
};
exports.updateReviewStatus = updateReviewStatus;
// Delete review (Admin)
const deleteReview = async (req, res) => {
    try {
        const { id } = req.params;
        const review = await review_1.default.findByIdAndDelete(id);
        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found",
            });
        }
        if (review.status === 'approved') {
            const Product = (await Promise.resolve().then(() => __importStar(require("../modal/product")))).default;
            const reviews = await review_1.default.find({
                product: review.product,
                status: "approved",
            });
            const totalReviews = reviews.length;
            const averageRating = totalReviews > 0
                ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
                : 0;
            await Product.findByIdAndUpdate(review.product, {
                averageRating: Math.round(averageRating * 10) / 10,
                totalReviews,
            });
        }
        return res.status(200).json({
            success: true,
            message: "Review deleted successfully",
        });
    }
    catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error deleting review",
            error: error.message,
        });
    }
};
exports.deleteReview = deleteReview;
// Reply to review (Admin)
const replyToReview = async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;
        const userId = req.user?.userId;
        const review = await review_1.default.findById(id);
        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found",
            });
        }
        review.response = {
            text,
            respondedBy: userId,
            respondedAt: new Date()
        };
        await review.save();
        return res.status(200).json({
            success: true,
            message: "Reply added successfully",
            data: review
        });
    }
    catch (error) {
        return res.status(500).json({
            success: false,
            message: "Error replying to review",
            error: error.message,
        });
    }
};
exports.replyToReview = replyToReview;
//# sourceMappingURL=reviewController.js.map