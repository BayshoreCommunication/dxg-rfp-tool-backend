"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const settingsController_1 = require("../controller/settingsController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
// All settings routes require auth
router.get("/", auth_1.authenticate, settingsController_1.getSettings);
router.put("/", auth_1.authenticate, (0, upload_1.uploadSingle)("logoFile"), settingsController_1.updateSettings);
router.delete("/", auth_1.authenticate, settingsController_1.deleteSettings);
exports.default = router;
//# sourceMappingURL=settingsRoute.js.map