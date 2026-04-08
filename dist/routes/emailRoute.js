"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const emailController_1 = require("../controller/emailController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Public tracking endpoints
router.get("/open/:trackingId", emailController_1.markEmailOpened);
router.get("/click/:trackingId", emailController_1.markEmailClicked);
// Protected endpoints
router.post("/send", auth_1.authenticate, emailController_1.sendProposalEmailCampaign);
router.get("/", auth_1.authenticate, emailController_1.getEmailCampaigns);
router.get("/stats", auth_1.authenticate, emailController_1.getEmailStats);
router.delete("/proposal/:proposalId", auth_1.authenticate, emailController_1.deleteEmailCampaignsByProposal);
router.delete("/:campaignId", auth_1.authenticate, emailController_1.deleteEmailCampaignById);
exports.default = router;
//# sourceMappingURL=emailRoute.js.map