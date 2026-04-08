"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const extractController_1 = require("../controller/extractController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/* POST /api/extract-proposal — upload a document and extract proposal fields via AI */
router.post("/", auth_1.authenticate, extractController_1.extractUpload.single("file"), extractController_1.extractProposal);
exports.default = router;
//# sourceMappingURL=extractRoute.js.map