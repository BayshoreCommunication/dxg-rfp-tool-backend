"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const admissionController_1 = require("../controller/admissionController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Routes
router.post("/", admissionController_1.createAdmission);
router.get("/", admissionController_1.getAdmissions);
router.get("/stats", admissionController_1.getAdmissionStats);
router.get("/:id", admissionController_1.getAdmissionById);
router.put("/:id", admissionController_1.updateAdmission);
router.patch("/:id", admissionController_1.updateAdmission);
router.delete("/:id", admissionController_1.deleteAdmission);
exports.default = router;
//# sourceMappingURL=admission.js.map