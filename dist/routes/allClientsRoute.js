"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const allClientsController_1 = require("../controller/allClientsController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const adminGuard = [auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin")];
router.get("/", ...adminGuard, allClientsController_1.getAdminClientsList);
router.patch("/:id/block", ...adminGuard, allClientsController_1.blockClient);
exports.default = router;
//# sourceMappingURL=allClientsRoute.js.map