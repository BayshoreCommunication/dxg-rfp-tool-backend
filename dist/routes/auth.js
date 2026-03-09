"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controller/authController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Public routes
router.post("/register", authController_1.signUp);
router.post("/login", authController_1.signInWithCredentials);
// Protected routes
router.get("/me", auth_1.authenticate, authController_1.getCurrentUser);
router.post("/logout", auth_1.authenticate, authController_1.signOut);
exports.default = router;
//# sourceMappingURL=auth.js.map