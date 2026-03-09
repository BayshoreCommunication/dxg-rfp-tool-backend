"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const feeController_1 = require("../controller/feeController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Fee routes
router.post("/", feeController_1.createFee);
router.post("/bulk", feeController_1.createBulkFees);
router.get("/", feeController_1.getFees);
router.get("/stats", feeController_1.getFeeStats);
router.get("/:id", feeController_1.getFeeById);
router.put("/:id", feeController_1.updateFee);
router.patch("/:id", feeController_1.updateFee);
router.delete("/:id", feeController_1.deleteFee);
// SMS routes
router.post("/reminder/sms", feeController_1.sendPaymentReminderSMS);
router.post("/overdue/sms", feeController_1.sendOverdueSMS);
router.post("/payment/sms", feeController_1.sendPaymentConfirmationSMS);
exports.default = router;
//# sourceMappingURL=fee.js.map