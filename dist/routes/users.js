"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const userController_1 = require("../controller/userController");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.authenticate);
// Get all users
router.get("/", userController_1.getUsers);
// Get user by ID
router.get("/:id", userController_1.getUserById);
// Update user
router.put("/:id", userController_1.updateUser);
// Delete user
router.delete("/:id", userController_1.deleteUser);
exports.default = router;
//# sourceMappingURL=users.js.map