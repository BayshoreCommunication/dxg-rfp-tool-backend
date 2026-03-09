"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const blogController_1 = require("../controller/blogController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = express_1.default.Router();
// Public routes
router.get("/", blogController_1.getBlogs);
router.get("/categories", blogController_1.getCategories);
router.get("/:id", blogController_1.getBlog);
// Protected routes (authenticated users only)
router.post("/", auth_1.authenticate, (0, upload_1.uploadSingle)("featuredImage"), blogController_1.createBlog);
router.put("/:id", auth_1.authenticate, (0, upload_1.uploadSingle)("featuredImage"), blogController_1.updateBlog);
router.delete("/:id", auth_1.authenticate, blogController_1.deleteBlog);
exports.default = router;
//# sourceMappingURL=blog.js.map