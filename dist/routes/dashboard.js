"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dashboardController_1 = require("../controller/dashboardController");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// Protected route to get dashboard statistics
router.get("/stats", auth_1.authenticate, dashboardController_1.getDashboardStats);
exports.default = router;
//# sourceMappingURL=dashboard.js.map