"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const reviewController_1 = require("../controller/reviewController");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// Public routes (authentication handled in controller for "me" parameter)
router.get("/", reviewController_1.getReviews);
// Customer routes
router.post("/", auth_1.authenticate, reviewController_1.createReview);
// Admin/Staff routes
router.patch("/:id/status", auth_1.authenticate, (0, auth_1.authorize)("admin", "staff"), reviewController_1.updateReviewStatus);
router.delete("/:id", auth_1.authenticate, (0, auth_1.authorize)("admin", "staff"), reviewController_1.deleteReview);
router.post("/:id/reply", auth_1.authenticate, (0, auth_1.authorize)("admin", "staff"), reviewController_1.replyToReview);
exports.default = router;
//# sourceMappingURL=review.js.map