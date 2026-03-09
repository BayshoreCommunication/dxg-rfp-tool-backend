"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const portfolioController_1 = require("../controller/portfolioController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
// Get portfolio (public endpoint - can be accessed without auth for public display)
router.get("/", portfolioController_1.getPortfolio);
// Create and update portfolio (require authentication and handle file uploads)
router.use(auth_1.authenticate);
const portfolioUploadFields = (0, upload_1.uploadFields)([
    { name: "appLogo", maxCount: 1 },
    { name: "favicon", maxCount: 1 },
]);
router.post("/", portfolioUploadFields, portfolioController_1.createPortfolio);
router.put("/", portfolioUploadFields, portfolioController_1.updatePortfolio);
router.patch("/", portfolioUploadFields, portfolioController_1.updatePortfolio);
exports.default = router;
//# sourceMappingURL=portfolio.js.map