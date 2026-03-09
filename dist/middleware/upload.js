"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadFields = exports.uploadMultiple = exports.uploadSingle = exports.uploadImage = void 0;
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const paths_1 = require("../utils/paths");
// Get upload directories using the utility function
const uploadsDir = (0, paths_1.getUploadPath)();
const tempDir = (0, paths_1.getUploadPath)("temp");
// Ensure uploads directory exists
try {
    if (!fs_1.default.existsSync(uploadsDir)) {
        fs_1.default.mkdirSync(uploadsDir, { recursive: true });
    }
    if (!fs_1.default.existsSync(tempDir)) {
        fs_1.default.mkdirSync(tempDir, { recursive: true });
    }
}
catch (error) {
    // In serverless, /tmp should already exist, but handle gracefully
    console.warn("Warning: Could not create upload directory:", error);
}
// Configure storage
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, tempDir);
    },
    filename: (_req, file, cb) => {
        // Generate unique filename
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const ext = path_1.default.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
});
// File filter to accept only images
const imageFilter = (_req, file, cb) => {
    // Allowed image formats
    const allowedMimes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "image/bmp",
    ];
    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    }
    else {
        cb(new Error("Invalid file type. Only JPEG, PNG, GIF, WebP, SVG, and BMP images are allowed."));
    }
};
// Configure multer
exports.uploadImage = (0, multer_1.default)({
    storage,
    fileFilter: imageFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max file size
    },
});
// Middleware for single image upload
const uploadSingle = (fieldName) => exports.uploadImage.single(fieldName);
exports.uploadSingle = uploadSingle;
// Middleware for multiple image uploads
const uploadMultiple = (fieldName, maxCount = 10) => exports.uploadImage.array(fieldName, maxCount);
exports.uploadMultiple = uploadMultiple;
// Middleware for multiple fields
const uploadFields = (fields) => exports.uploadImage.fields(fields);
exports.uploadFields = uploadFields;
//# sourceMappingURL=upload.js.map