"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertImageToWebP = exports.uploadToImgBB = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
/**
 * Converts any image format to WebP using Sharp
 * @param inputPath Original image file path
 * @returns Path to the converted WebP file
 */
const convertToWebP = async (inputPath) => {
    try {
        const parsedPath = path_1.default.parse(inputPath);
        const outputPath = path_1.default.join(parsedPath.dir, `${parsedPath.name}.webp`);
        // Convert image to WebP with optimized settings
        await (0, sharp_1.default)(inputPath)
            .webp({
            quality: 85, // Good balance between quality and file size
            effort: 6, // Compression effort (0-6, higher = better compression but slower)
        })
            .toFile(outputPath);
        // Delete original file after conversion
        if (fs_1.default.existsSync(inputPath)) {
            fs_1.default.unlinkSync(inputPath);
        }
        return outputPath;
    }
    catch (error) {
        console.error("WebP conversion error:", error);
        throw new Error(`Failed to convert image to WebP: ${error.message}`);
    }
};
/**
 * Uploads an image to ImgBB after converting it to WebP format
 * @param filePath Path to the image file (any format)
 * @returns The URL of the uploaded WebP image
 */
const uploadToImgBB = async (filePath) => {
    const apiKey = process.env.IMAGEBB_API_KEY;
    if (!apiKey) {
        throw new Error("IMAGEBB_API_KEY is not defined in environment variables");
    }
    let webpPath = filePath;
    try {
        // Convert to WebP if not already in WebP format
        const ext = path_1.default.extname(filePath).toLowerCase();
        if (ext !== ".webp") {
            console.log(`Converting ${ext} to WebP...`);
            webpPath = await convertToWebP(filePath);
            console.log(`Converted to WebP: ${webpPath}`);
        }
        // Read the WebP file
        const fileStream = fs_1.default.readFileSync(webpPath);
        const base64Image = fileStream.toString("base64");
        const formData = new URLSearchParams();
        formData.append("key", apiKey);
        formData.append("image", base64Image);
        const response = await fetch("https://api.imgbb.com/1/upload", {
            method: "POST",
            body: formData,
        });
        const data = (await response.json());
        if (data.success) {
            // Clean up the local WebP file after successful upload
            if (fs_1.default.existsSync(webpPath)) {
                fs_1.default.unlinkSync(webpPath);
            }
            return data.data.url;
        }
        else {
            throw new Error(data.error?.message || "Failed to upload to ImgBB");
        }
    }
    catch (error) {
        // Clean up files in case of error
        if (webpPath !== filePath && fs_1.default.existsSync(webpPath)) {
            fs_1.default.unlinkSync(webpPath);
        }
        if (fs_1.default.existsSync(filePath)) {
            fs_1.default.unlinkSync(filePath);
        }
        throw new Error(`ImgBB Upload Error: ${error.message}`);
    }
};
exports.uploadToImgBB = uploadToImgBB;
/**
 * Converts an image to WebP and saves it to the specified output path
 * Useful for direct file conversions without uploading
 * @param inputPath Original image file path
 * @param outputPath Desired output path for WebP file
 * @param options Sharp WebP options
 */
const convertImageToWebP = async (inputPath, outputPath, options) => {
    try {
        const finalOutputPath = outputPath || inputPath.replace(path_1.default.extname(inputPath), ".webp");
        await (0, sharp_1.default)(inputPath)
            .webp({
            quality: options?.quality || 85,
            effort: options?.effort || 6,
        })
            .toFile(finalOutputPath);
        return finalOutputPath;
    }
    catch (error) {
        throw new Error(`WebP conversion failed: ${error.message}`);
    }
};
exports.convertImageToWebP = convertImageToWebP;
//# sourceMappingURL=uploadToImgBB.js.map