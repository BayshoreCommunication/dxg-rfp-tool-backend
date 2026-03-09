"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const orderController_1 = require("../controller/orderController");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// All routes are protected
router.use(auth_1.authenticate);
// Admin/Staff routes
router.get("/", (0, auth_1.authorize)("admin", "staff"), orderController_1.getOrders);
router.get("/stats", (0, auth_1.authorize)("admin", "staff"), orderController_1.getOrderStats);
router.get("/recent", (0, auth_1.authorize)("admin", "staff"), orderController_1.getRecentOrders);
// Customer routes
router.get("/my-orders", orderController_1.getMyOrders);
// Shared/General routes
router.get("/:id", orderController_1.getOrder);
router.post("/", orderController_1.createOrder); // Admin/Customer can create
// Admin/Staff modify routes
router.put("/:id", (0, auth_1.authorize)("admin", "staff"), orderController_1.updateOrder); // General edit
router.delete("/:id", (0, auth_1.authorize)("admin", "staff"), orderController_1.deleteOrder); // Delete
router.patch("/:id/status", (0, auth_1.authorize)("admin", "staff"), orderController_1.updateOrderStatus);
router.patch("/:id/payment", (0, auth_1.authorize)("admin", "staff"), orderController_1.updatePaymentStatus);
router.post("/:id/refund", (0, auth_1.authorize)("admin", "staff"), orderController_1.refundOrder);
exports.default = router;
//# sourceMappingURL=order.js.map