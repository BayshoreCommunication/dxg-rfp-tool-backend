"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardStats = void 0;
const blog_1 = __importDefault(require("../modal/blog"));
const product_1 = __importDefault(require("../modal/product"));
const getDashboardStats = async (req, res) => {
    try {
        // Run queries in parallel for better performance
        const [totalProducts, activeProducts, draftProducts, archivedProducts, totalBlogs, publishedBlogs, draftBlogs, archivedBlogs,] = await Promise.all([
            product_1.default.countDocuments(),
            product_1.default.countDocuments({ status: "active" }),
            product_1.default.countDocuments({ status: "draft" }),
            product_1.default.countDocuments({ status: "archived" }),
            blog_1.default.countDocuments(),
            blog_1.default.countDocuments({ status: "published" }),
            blog_1.default.countDocuments({ status: "draft" }),
            blog_1.default.countDocuments({ status: "archived" }),
        ]);
        // Prepare data for charts
        const productStats = {
            total: totalProducts,
            byStatus: {
                active: activeProducts,
                draft: draftProducts,
                archived: archivedProducts,
            },
            chartData: [
                { name: "Active", value: activeProducts, color: "#22c55e" }, // Green
                { name: "Draft", value: draftProducts, color: "#eab308" }, // Yellow
                { name: "Archived", value: archivedProducts, color: "#ef4444" }, // Red
            ],
        };
        const blogStats = {
            total: totalBlogs,
            byStatus: {
                published: publishedBlogs,
                draft: draftBlogs,
                archived: archivedBlogs,
            },
            chartData: [
                { name: "Published", value: publishedBlogs, color: "#3b82f6" }, // Blue
                { name: "Draft", value: draftBlogs, color: "#eab308" }, // Yellow
                { name: "Archived", value: archivedBlogs, color: "#ef4444" }, // Red
            ],
        };
        res.status(200).json({
            success: true,
            data: {
                products: productStats,
                blogs: blogStats,
            },
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching dashboard statistics",
            error: error.message,
        });
    }
};
exports.getDashboardStats = getDashboardStats;
//# sourceMappingURL=dashboardController.js.map