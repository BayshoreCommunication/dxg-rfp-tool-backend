"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const categoryController_1 = require("../controller/categoryController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = express_1.default.Router();
// Public routes
router.get("/", categoryController_1.getCategories);
router.get("/:id", categoryController_1.getCategory);
// Protected routes (authenticated users only)
router.post("/", auth_1.authenticate, (0, upload_1.uploadSingle)("image"), categoryController_1.createCategory);
router.put("/:id", auth_1.authenticate, (0, upload_1.uploadSingle)("image"), categoryController_1.updateCategory);
router.delete("/:id", auth_1.authenticate, categoryController_1.deleteCategory);
exports.default = router;
//# sourceMappingURL=category.js.map