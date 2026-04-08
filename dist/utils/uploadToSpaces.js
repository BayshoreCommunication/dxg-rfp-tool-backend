"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadToSpaces = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const client_s3_1 = require("@aws-sdk/client-s3");
const contentTypes = {
    // Images
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    // Documents
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    // Video
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
};
const getSpacesConfig = () => {
    const bucket = process.env.DO_SPACES_BUCKET || "";
    const region = process.env.DO_SPACES_REGION || "";
    const key = process.env.DO_SPACES_KEY || "";
    const secret = process.env.DO_SPACES_SECRET || "";
    const folder = process.env.DO_FOLDER_NAME || "";
    if (!bucket || !region || !key || !secret) {
        throw new Error("Missing DigitalOcean Spaces configuration in environment");
    }
    return { bucket, region, key, secret, folder };
};
const getContentType = (filePath) => {
    const ext = path_1.default.extname(filePath).toLowerCase();
    return contentTypes[ext] || "application/octet-stream";
};
const uploadToSpaces = async (filePath, objectKey) => {
    const { bucket, region, key, secret } = getSpacesConfig();
    const client = new client_s3_1.S3Client({
        region,
        endpoint: `https://${region}.digitaloceanspaces.com`,
        credentials: {
            accessKeyId: key,
            secretAccessKey: secret,
        },
    });
    const fileBuffer = await fs_1.default.promises.readFile(filePath);
    const contentType = getContentType(filePath);
    await client.send(new client_s3_1.PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: fileBuffer,
        ACL: "public-read",
        ContentType: contentType,
    }));
    // Clean up local file after upload
    try {
        await fs_1.default.promises.unlink(filePath);
    }
    catch {
        // Ignore cleanup errors
    }
    return `https://${bucket}.${region}.digitaloceanspaces.com/${objectKey}`;
};
exports.uploadToSpaces = uploadToSpaces;
//# sourceMappingURL=uploadToSpaces.js.map