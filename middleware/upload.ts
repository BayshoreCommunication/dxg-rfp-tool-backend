import { Request } from "express";
import fs from "fs";
import multer, { FileFilterCallback } from "multer";
import path from "path";
import { getUploadPath } from "../utils/paths";

// Get upload directories using the utility function
const uploadsDir = getUploadPath();
const tempDir = getUploadPath("temp");

// Ensure uploads directory exists
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
} catch (error) {
  // In serverless, /tmp should already exist, but handle gracefully
  console.warn("Warning: Could not create upload directory:", error);
}

// Configure storage
const storage = multer.diskStorage({
  destination: (_req: Request, _file: any, cb: any) => {
    cb(null, tempDir);
  },
  filename: (_req: Request, file: any, cb: any) => {
    // Generate unique filename
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

// File filter to accept only images
const imageFilter = (_req: Request, file: any, cb: FileFilterCallback) => {
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
  } else {
    cb(
      new Error(
        "Invalid file type. Only JPEG, PNG, GIF, WebP, SVG, and BMP images are allowed."
      )
    );
  }
};

// File filter for proposal documents (PDF, Office, images, video)
const documentFilter = (_req: Request, file: any, cb: FileFilterCallback) => {
  const allowedMimes = [
    // Images
    "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/bmp",
    // Documents
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    // Video
    "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/webm",
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
};

// Configure multer
export const uploadImage = multer({
  storage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
});

// For proposal support documents & AV quote files (50MB max)
export const uploadDocument = multer({
  storage,
  fileFilter: documentFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

// Middleware for single image upload
export const uploadSingle = (fieldName: string) =>
  uploadImage.single(fieldName);

// Middleware for multiple image uploads
export const uploadMultiple = (fieldName: string, maxCount: number = 10) =>
  uploadImage.array(fieldName, maxCount);

// Middleware for multiple fields
export const uploadFields = (
  fields: Array<{ name: string; maxCount?: number }>
) => uploadImage.fields(fields);

// Middleware for proposal file uploads (support docs + AV quote files)
export const uploadProposalDocs = uploadDocument.fields([
  { name: "supportDocuments", maxCount: 20 },
  { name: "avQuoteFiles", maxCount: 10 },
]);
