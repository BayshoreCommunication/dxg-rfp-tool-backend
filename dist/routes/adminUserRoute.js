"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminUserRoute_1 = require("../controller/adminUserRoute");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
router.get("/me", auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin"), adminUserRoute_1.getSignedInAdminProfile);
router.put("/me", auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin"), (0, upload_1.uploadSingle)("avatarFile"), adminUserRoute_1.updateSignedInAdminProfile);
exports.default = router;
//# sourceMappingURL=adminUserRoute.js.map