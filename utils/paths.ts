import path from "path";

/**
 * Get the base upload directory path
 * In serverless environments (Vercel), use /tmp which is writable
 * In local development, use the uploads directory relative to the project root
 */
export function getUploadsDir(): string {
  const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
  
  if (isServerless) {
    return "/tmp";
  }
  
  // In local development, use the uploads directory
  return path.join(process.cwd(), "uploads");
}

/**
 * Get the full path to an upload subdirectory
 * @param subdir - Subdirectory name (e.g., "portfolio", "temp")
 */
export function getUploadPath(subdir?: string): string {
  const baseDir = getUploadsDir();
  return subdir ? path.join(baseDir, subdir) : baseDir;
}

/**
 * Convert an absolute file path to a URL path
 * @param filePath - Absolute file path
 * @returns URL path starting with /uploads/
 */
export function getUploadUrl(filePath: string): string {
  const uploadsDir = getUploadsDir();
  const relativePath = path.relative(uploadsDir, filePath);
  return `/uploads/${relativePath.replace(/\\/g, "/")}`;
}

/**
 * Convert a URL path to an absolute file path
 * @param urlPath - URL path starting with /uploads/
 * @returns Absolute file path
 */
export function getUploadFilePath(urlPath: string): string {
  const uploadsDir = getUploadsDir();
  const relativePath = urlPath.replace(/^\/uploads\//, "");
  return path.join(uploadsDir, relativePath);
}

