"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUploadsDir = getUploadsDir;
exports.getUploadPath = getUploadPath;
exports.getUploadUrl = getUploadUrl;
exports.getUploadFilePath = getUploadFilePath;
const path_1 = __importDefault(require("path"));
/**
 * Get the base upload directory path
 * In serverless environments (Vercel), use /tmp which is writable
 * In local development, use the uploads directory relative to the project root
 */
function getUploadsDir() {
    const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (isServerless) {
        return "/tmp";
    }
    // In local development, use the uploads directory
    return path_1.default.join(process.cwd(), "uploads");
}
/**
 * Get the full path to an upload subdirectory
 * @param subdir - Subdirectory name (e.g., "portfolio", "temp")
 */
function getUploadPath(subdir) {
    const baseDir = getUploadsDir();
    return subdir ? path_1.default.join(baseDir, subdir) : baseDir;
}
/**
 * Convert an absolute file path to a URL path
 * @param filePath - Absolute file path
 * @returns URL path starting with /uploads/
 */
function getUploadUrl(filePath) {
    const uploadsDir = getUploadsDir();
    const relativePath = path_1.default.relative(uploadsDir, filePath);
    return `/uploads/${relativePath.replace(/\\/g, "/")}`;
}
/**
 * Convert a URL path to an absolute file path
 * @param urlPath - URL path starting with /uploads/
 * @returns Absolute file path
 */
function getUploadFilePath(urlPath) {
    const uploadsDir = getUploadsDir();
    const relativePath = urlPath.replace(/^\/uploads\//, "");
    return path_1.default.join(uploadsDir, relativePath);
}
//# sourceMappingURL=paths.js.map