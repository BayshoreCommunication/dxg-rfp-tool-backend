"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const attendanceController_1 = require("../controller/attendanceController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Routes
router.post("/", attendanceController_1.markAttendance);
router.post("/batch", attendanceController_1.markBatchAttendance);
router.get("/", attendanceController_1.getAttendances);
router.get("/stats", attendanceController_1.getAttendanceStats);
router.get("/report", attendanceController_1.getStudentAttendanceReport);
router.post("/report/sms", attendanceController_1.sendAttendanceReportSMS);
router.delete("/:id", attendanceController_1.deleteAttendance);
exports.default = router;
//# sourceMappingURL=attendance.js.map