"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = exports.runExpirationCheck = void 0;
const notificationService_1 = require("./notificationService");
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const settingsModel_1 = __importDefault(require("../modal/settingsModel"));
const parseExpiryDays = (expirySetting) => {
    if (!expirySetting || typeof expirySetting !== "string")
        return null;
    const match = expirySetting.match(/(\d+)/);
    if (!match)
        return null;
    const days = parseInt(match[1], 10);
    return Number.isFinite(days) && days > 0 ? days : null;
};
const runExpirationCheck = async () => {
    try {
        const activeProposals = await proposalsModel_1.default.find({ isActive: true });
        const settingsByUserId = new Map();
        for (const proposal of activeProposals) {
            const userId = proposal.userId;
            const userIdText = userId ? String(userId) : "";
            let settings = userIdText ? settingsByUserId.get(userIdText) : null;
            if (!settings && userIdText) {
                settings = await settingsModel_1.default.findOne({ userId });
                settingsByUserId.set(userIdText, settings);
            }
            const expirySetting = settings?.proposals?.expiryDate;
            const days = parseExpiryDays(expirySetting);
            if (!days)
                continue;
            const creationDate = new Date(proposal.createdAt);
            const expiryDate = new Date(creationDate.getTime() + days * 24 * 60 * 60 * 1000);
            const now = new Date();
            const msUntilExpiry = expiryDate.getTime() - now.getTime();
            const proposalTitle = proposal.event?.eventName?.trim() || "Untitled Proposal";
            if (userIdText && msUntilExpiry > 0 && msUntilExpiry <= 24 * 60 * 60 * 1000) {
                const expiryDay = expiryDate.toISOString().slice(0, 10);
                await (0, notificationService_1.createNotification)({
                    userId: userIdText,
                    proposalId: String(proposal._id),
                    type: "proposal_expiring_soon",
                    title: "Proposal expires tomorrow",
                    message: `"${proposalTitle}" will expire on ${expiryDate.toLocaleDateString()}.`,
                    dedupeKey: `proposal-expiring-soon:${proposal._id}:${expiryDay}`,
                    metadata: {
                        expiryDate: expiryDate.toISOString(),
                    },
                });
            }
            if (now > expiryDate) {
                proposal.isActive = false;
                proposal.isOpen = false;
                proposal.status = "rejected";
                await proposal.save();
                if (userIdText) {
                    await (0, notificationService_1.createNotification)({
                        userId: userIdText,
                        proposalId: String(proposal._id),
                        type: "proposal_expired",
                        title: "Proposal expired",
                        message: `"${proposalTitle}" has expired and is now closed.`,
                        dedupeKey: `proposal-expired:${proposal._id}`,
                        metadata: {
                            expiryDate: expiryDate.toISOString(),
                        },
                    });
                }
                console.log(`[Cron] Auto-expired proposal ${proposal._id}`);
            }
        }
    }
    catch (error) {
        console.error(`[Cron] Proposal expiration error:`, error);
    }
};
exports.runExpirationCheck = runExpirationCheck;
const startCronJobs = () => {
    // Run once immediately on startup
    (0, exports.runExpirationCheck)();
    // Run every 12 hours (12 * 60 * 60 * 1000 ms)
    setInterval(() => {
        (0, exports.runExpirationCheck)();
    }, 12 * 60 * 60 * 1000);
};
exports.startCronJobs = startCronJobs;
//# sourceMappingURL=cronJobs.js.map