"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardOverview = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const emailModel_1 = __importDefault(require("../modal/emailModel"));
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const getDashboardOverview = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        if (!mongoose_1.default.isValidObjectId(userId)) {
            res.status(400).json({ success: false, message: "Invalid user id." });
            return;
        }
        const userObjectId = new mongoose_1.default.Types.ObjectId(userId);
        const [totalProposals, emailAgg, proposalViewsAgg, latestProposals,] = await Promise.all([
            proposalsModel_1.default.countDocuments({ userId: userObjectId }),
            emailModel_1.default.aggregate([
                { $match: { userId: userObjectId } },
                {
                    $group: {
                        _id: null,
                        totalEmailSent: { $sum: "$sentCount" },
                        totalEmailClicked: { $sum: "$clickedCount" },
                    },
                },
            ]),
            proposalsModel_1.default.aggregate([
                { $match: { userId: userObjectId } },
                {
                    $group: {
                        _id: null,
                        totalProposalViews: { $sum: "$viewsCount" },
                    },
                },
            ]),
            proposalsModel_1.default.find({ userId: userObjectId })
                .sort({ createdAt: -1 })
                .limit(5)
                .select("_id status isActive isFavorite viewsCount createdAt event contact"),
        ]);
        const totalEmailSent = emailAgg[0]?.totalEmailSent || 0;
        const totalEmailClicked = emailAgg[0]?.totalEmailClicked || 0;
        const totalProposalViews = proposalViewsAgg[0]?.totalProposalViews || 0;
        res.status(200).json({
            success: true,
            message: "Dashboard overview fetched successfully",
            data: {
                totals: {
                    totalProposals,
                    totalEmailSent,
                    totalEmailClicked,
                    totalProposalViews,
                },
                latestProposals,
            },
        });
    }
    catch (error) {
        console.error("Get dashboard overview error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching dashboard overview",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getDashboardOverview = getDashboardOverview;
//# sourceMappingURL=dashboardController.js.map