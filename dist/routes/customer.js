"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const customerController_1 = require("../controller/customerController");
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
// ============================================
// PUBLIC ROUTES (No Authentication Required)
// ============================================
// Customer Authentication
router.post("/signup", customerController_1.customerSignup);
router.post("/signin", customerController_1.customerSignin);
router.post("/forgot-password", customerController_1.forgotPassword);
router.post("/reset-password", customerController_1.resetPassword);
// ============================================
// AUTHENTICATED CUSTOMER ROUTES
// ============================================
// Customer Profile Management
router.get("/me", auth_1.authenticate, customerController_1.getCurrentCustomer);
router.put("/me", auth_1.authenticate, customerController_1.updateCurrentCustomer);
router.put("/me/password", auth_1.authenticate, customerController_1.updatePassword);
// Customer Address Management
router.post("/me/addresses", auth_1.authenticate, customerController_1.addCurrentCustomerAddress);
router.put("/me/addresses/:addressId", auth_1.authenticate, customerController_1.updateCurrentCustomerAddress);
router.delete("/me/addresses/:addressId", auth_1.authenticate, customerController_1.deleteCurrentCustomerAddress);
// ============================================
// ADMIN/STAFF ROUTES (Protected)
// ============================================
// All admin routes require authentication and authorization
router.use(auth_1.authenticate);
router.use((0, auth_1.authorize)("admin", "staff"));
// Customer Management
router.get("/", customerController_1.getCustomers);
router.get("/stats", customerController_1.getCustomerStats);
router.get("/:id", customerController_1.getCustomer);
router.get("/:id/orders", customerController_1.getCustomerOrders);
router.post("/", customerController_1.createCustomer);
router.put("/:id", customerController_1.updateCustomer);
router.delete("/:id", customerController_1.deleteCustomer);
// Address Management (Admin)
router.post("/:id/addresses", customerController_1.addCustomerAddress);
router.put("/:id/addresses/:addressId", customerController_1.updateCustomerAddress);
router.delete("/:id/addresses/:addressId", customerController_1.deleteCustomerAddress);
exports.default = router;
//# sourceMappingURL=customer.js.map