"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dashboardController_1 = require("../controller/dashboardController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get("/overview", auth_1.authenticate, dashboardController_1.getDashboardOverview);
exports.default = router;
//# sourceMappingURL=dashboardRoute.js.map