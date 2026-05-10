"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminUsersController_1 = require("../controller/adminUsersController");
const adminUserRoute_1 = require("../controller/adminUserRoute");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
const adminGuard = [auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin")];
const superAdminGuard = [auth_1.authenticate, (0, auth_1.authorize)("super_admin", "superadmin")];
// Signed-in admin profile (any admin)
router.get("/me", ...adminGuard, adminUserRoute_1.getSignedInAdminProfile);
router.put("/me", ...adminGuard, (0, upload_1.uploadSingle)("avatarFile"), adminUserRoute_1.updateSignedInAdminProfile);
// Admin user management (super admin only)
router.get("/", ...superAdminGuard, adminUsersController_1.getAdminUsers);
router.post("/", ...superAdminGuard, adminUsersController_1.createAdminUser);
router.put("/:id", ...superAdminGuard, adminUsersController_1.updateAdminUser);
router.delete("/:id", ...superAdminGuard, adminUsersController_1.deleteAdminUser);
exports.default = router;
//# sourceMappingURL=adminUserRoute.js.map