"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const qrcodeController_1 = require("../controller/qrcodeController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// QR code routes
router.post("/", qrcodeController_1.createQRCode);
router.get("/", qrcodeController_1.getQRCodes);
router.get("/:id", qrcodeController_1.getQRCodeById);
router.put("/:id", qrcodeController_1.updateQRCode);
router.patch("/:id", qrcodeController_1.updateQRCode);
router.delete("/:id", qrcodeController_1.deleteQRCode);
// Bulk operations
router.post("/bulk", qrcodeController_1.bulkGenerateQRCodes);
// Verify QR code (public endpoint for scanning)
router.post("/verify", qrcodeController_1.verifyQRCode);
exports.default = router;
//# sourceMappingURL=qrcode.js.map