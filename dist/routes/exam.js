"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const examController_1 = require("../controller/examController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Exam routes
router.post("/", examController_1.createExam);
router.get("/", examController_1.getExams);
router.get("/stats", examController_1.getExamStats);
router.get("/:id", examController_1.getExamById);
router.put("/:id", examController_1.updateExam);
router.patch("/:id", examController_1.updateExam);
router.delete("/:id", examController_1.deleteExam);
// Exam schedule SMS
router.post("/schedule/sms", examController_1.sendExamScheduleSMS);
// Exam result routes
router.post("/results", examController_1.createExamResult);
router.post("/results/batch", examController_1.createBatchExamResults);
router.get("/results", examController_1.getExamResults);
router.post("/results/sms", examController_1.sendExamResultSMS);
exports.default = router;
//# sourceMappingURL=exam.js.map