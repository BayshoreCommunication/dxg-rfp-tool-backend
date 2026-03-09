"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const smsController_1 = require("../controller/smsController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// SMS routes
router.post("/send", smsController_1.sendSingleSMS);
router.post("/bulk", smsController_1.sendBulkSMSSameMessage);
router.post("/bulk/custom", smsController_1.sendBulkSMSDifferentMessages);
router.post("/send/students", smsController_1.sendSMSToStudents);
// SMS history and stats
router.get("/", smsController_1.getSMSHistory);
router.get("/stats", smsController_1.getSMSStats);
router.get("/:id", smsController_1.getSMSById);
exports.default = router;
//# sourceMappingURL=sms.js.map