"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const mongoose_1 = __importStar(require("mongoose"));
const customerAddressSchema = new mongoose_1.Schema({
    fullName: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    addressLine1: { type: String, required: true },
    addressLine2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zipCode: { type: String, required: true },
    country: { type: String, required: true, default: "Bangladesh" },
    addressType: {
        type: String,
        enum: ["billing", "shipping", "both"],
        default: "both",
    },
    isDefaultBilling: { type: Boolean, default: false },
    isDefaultShipping: { type: Boolean, default: false },
}, { _id: true });
const customerSchema = new mongoose_1.Schema({
    name: {
        type: String,
        required: [true, "Name is required"],
        trim: true,
    },
    email: {
        type: String,
        required: [true, "Email is required"],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        minlength: [6, "Password must be at least 6 characters"],
        select: false, // Don't return password by default
    },
    phone: {
        type: String,
        trim: true,
    },
    avatar: {
        type: String,
    },
    isEmailVerified: {
        type: Boolean,
        default: false,
    },
    // Addresses - Separate billing and shipping
    billingAddresses: [customerAddressSchema],
    shippingAddresses: [customerAddressSchema],
    // Wishlist
    wishlist: [
        {
            type: mongoose_1.Schema.Types.ObjectId,
            ref: "Product",
        },
    ],
    // E-commerce stats
    totalOrders: {
        type: Number,
        default: 0,
    },
    totalSpent: {
        type: Number,
        default: 0,
    },
    lastOrderDate: {
        type: Date,
    },
    // Password reset
    resetPasswordToken: { type: String },
    resetPasswordExpire: { type: Date },
}, {
    timestamps: true,
});
// Indexes
customerSchema.index({ email: 1 });
customerSchema.index({ resetPasswordToken: 1 });
// Hash password before saving
customerSchema.pre("save", async function (next) {
    if (!this.isModified("password") || !this.password) {
        return next();
    }
    const salt = await bcryptjs_1.default.genSalt(10);
    this.password = await bcryptjs_1.default.hash(this.password, salt);
    next();
});
// Compare password method
customerSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.password) {
        return false;
    }
    return bcryptjs_1.default.compare(candidatePassword, this.password);
};
// Virtual for all addresses (billing + shipping combined)
customerSchema.virtual("addresses").get(function () {
    const allAddresses = [];
    // Add billing addresses
    this.billingAddresses.forEach((addr) => {
        allAddresses.push({
            ...addr,
            addressType: addr.addressType === "both" ? "billing" : addr.addressType,
        });
    });
    // Add shipping addresses (avoid duplicates if addressType is "both")
    this.shippingAddresses.forEach((addr) => {
        if (addr.addressType !== "both") {
            allAddresses.push({
                ...addr,
                addressType: "shipping",
            });
        }
    });
    return allAddresses;
});
const Customer = mongoose_1.default.models.Customer ||
    mongoose_1.default.model("Customer", customerSchema);
exports.default = Customer;
//# sourceMappingURL=customer.js.map