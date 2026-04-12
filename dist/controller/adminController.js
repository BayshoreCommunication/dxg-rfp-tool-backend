"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminOverview = void 0;
const emailModel_1 = __importDefault(require("../modal/emailModel"));
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const userModel_1 = __importDefault(require("../modal/userModel"));
const isAdminRole = (role) => {
    const normalized = String(role || "").toLowerCase().trim();
    return (normalized === "admin" ||
        normalized === "super_admin" ||
        normalized === "superadmin");
};
const CLIENT_ROLE_FILTER = {
    role: { $nin: ["admin", "super_admin", "superadmin"] },
};
const getAdminOverview = async (req, res) => {
    try {
        if (!req.user?.userId || !isAdminRole(req.user.role)) {
            res.status(403).json({
                success: false,
                message: "Only admin can access this resource.",
            });
            return;
        }
        const [totalClients, totalProposals, emailStats, latestClients] = await Promise.all([
            userModel_1.default.countDocuments(CLIENT_ROLE_FILTER),
            proposalsModel_1.default.countDocuments({}),
            emailModel_1.default.aggregate([
                {
                    $group: {
                        _id: null,
                        totalEmailSent: { $sum: "$sentCount" },
                        totalClick: { $sum: "$clickedCount" },
                    },
                },
            ]),
            userModel_1.default.aggregate([
                { $match: CLIENT_ROLE_FILTER },
                { $sort: { createdAt: -1 } },
                { $limit: 10 },
                {
                    $lookup: {
                        from: "proposals",
                        let: { userId: "$_id" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ["$userId", "$$userId"] },
                                },
                            },
                            { $count: "count" },
                        ],
                        as: "proposalStats",
                    },
                },
                {
                    $lookup: {
                        from: "emailcampaigns",
                        let: { userId: "$_id" },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ["$userId", "$$userId"] },
                                },
                            },
                            {
                                $group: {
                                    _id: null,
                                    totalEmailSent: { $sum: "$sentCount" },
                                },
                            },
                        ],
                        as: "emailStats",
                    },
                },
                {
                    $project: {
                        _id: 0,
                        id: "$_id",
                        name: 1,
                        email: 1,
                        joinDate: "$createdAt",
                        totalProposals: {
                            $ifNull: [{ $first: "$proposalStats.count" }, 0],
                        },
                        totalEmailSent: {
                            $ifNull: [{ $first: "$emailStats.totalEmailSent" }, 0],
                        },
                    },
                },
            ]),
        ]);
        const totals = {
            totalClients,
            totalProposals,
            totalEmailSent: emailStats[0]?.totalEmailSent || 0,
            totalClick: emailStats[0]?.totalClick || 0,
        };
        res.status(200).json({
            success: true,
            message: "Admin overview fetched successfully",
            data: {
                totals,
                latestClients,
            },
        });
    }
    catch (error) {
        console.error("Get admin overview error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching admin overview",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getAdminOverview = getAdminOverview;
//# sourceMappingURL=adminController.js.map