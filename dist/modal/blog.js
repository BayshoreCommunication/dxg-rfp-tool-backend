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
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
// Blog Schema
const blogSchema = new mongoose_1.Schema({
    title: {
        type: String,
        required: [true, "Title is required"],
        trim: true,
        maxlength: [200, "Title cannot exceed 200 characters"],
    },
    slug: {
        type: String,
        required: [true, "Slug is required"],
        unique: true,
        trim: true,
        lowercase: true,
    },
    body: {
        type: String,
        required: [true, "Body content is required"],
    },
    excerpt: {
        type: String,
        maxlength: [500, "Excerpt cannot exceed 500 characters"],
    },
    author: {
        type: String,
        required: [true, "Author is required"],
        trim: true,
    },
    category: {
        type: String,
        trim: true,
    },
    tags: {
        type: [String],
        default: [],
    },
    featuredImage: {
        type: String,
    },
    status: {
        type: String,
        enum: ["draft", "published", "archived"],
        default: "draft",
    },
    featured: {
        type: Boolean,
        default: false,
    },
    // SEO Meta Tags
    metaTitle: {
        type: String,
        maxlength: [60, "Meta title should not exceed 60 characters"],
    },
    metaDescription: {
        type: String,
        maxlength: [160, "Meta description should not exceed 160 characters"],
    },
    metaKeywords: {
        type: String,
    },
    publishedAt: {
        type: Date,
    },
    createdBy: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "User",
    },
}, {
    timestamps: true,
});
// Index for better search performance
blogSchema.index({ title: "text", body: "text", tags: "text" });
blogSchema.index({ status: 1, publishedAt: -1 });
const Blog = mongoose_1.default.model("Blog", blogSchema);
exports.default = Blog;
//# sourceMappingURL=blog.js.map