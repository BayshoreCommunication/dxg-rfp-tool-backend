"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminController_1 = require("../controller/adminController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get("/overview", auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin"), adminController_1.getAdminOverview);
exports.default = router;
//# sourceMappingURL=adminRoute.js.map