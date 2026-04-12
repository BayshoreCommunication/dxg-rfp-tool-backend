"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const allClientsController_1 = require("../controller/allClientsController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Admin only - paginated clients list with search and counts
router.get("/", auth_1.authenticate, (0, auth_1.authorize)("admin", "super_admin", "superadmin"), allClientsController_1.getAdminClientsList);
exports.default = router;
//# sourceMappingURL=allClientsRoute.js.map