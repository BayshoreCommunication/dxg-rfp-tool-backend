"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = exports.runExpirationCheck = void 0;
const proposalsModel_1 = __importDefault(require("../modal/proposalsModel"));
const settingsModel_1 = __importDefault(require("../modal/settingsModel"));
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
            if (!expirySetting || typeof expirySetting !== "string")
                continue;
            const match = expirySetting.match(/(\d+)/);
            if (!match)
                continue;
            const days = parseInt(match[1], 10);
            if (isNaN(days) || days <= 0)
                continue;
            const creationDate = new Date(proposal.createdAt);
            const expiryDate = new Date(creationDate.getTime() + days * 24 * 60 * 60 * 1000);
            const now = new Date();
            if (now > expiryDate) {
                proposal.isActive = false;
                proposal.isOpen = false;
                proposal.status = "rejected";
                await proposal.save();
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