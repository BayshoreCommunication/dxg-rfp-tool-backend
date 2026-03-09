"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const productController_1 = require("../controller/productController");
const auth_1 = require("../middleware/auth");
const upload_1 = require("../middleware/upload");
const router = express_1.default.Router();
// Public routes
router.get("/", productController_1.getProducts);
router.get("/categories", productController_1.getCategories);
router.get("/:id", productController_1.getProduct);
// Protected routes (authenticated users only)
router.post("/", auth_1.authenticate, upload_1.uploadImage.any(), // Accept any file fields (for variants)
productController_1.createProduct);
router.put("/:id", auth_1.authenticate, upload_1.uploadImage.any(), // Accept any file fields (for variants)
productController_1.updateProduct);
router.delete("/:id", auth_1.authenticate, productController_1.deleteProduct);
exports.default = router;
//# sourceMappingURL=product.js.map