import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type SpacesConfig = {
  bucket: string;
  region: string;
  key: string;
  secret: string;
  folder: string;
};

const contentTypes: Record<string, string> = {
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

const getSpacesConfig = (): SpacesConfig => {
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

const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return contentTypes[ext] || "application/octet-stream";
};

const createSpacesClient = () => {
  const { bucket, region, key, secret } = getSpacesConfig();
  const client = new S3Client({
    region,
    endpoint: `https://${region}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId: key,
      secretAccessKey: secret,
    },
  });
  return { bucket, region, client };
};

const putObjectFromFile = async (
  filePath: string,
  objectKey: string,
  acl?: "public-read"
): Promise<string> => {
  const { bucket, region, client } = createSpacesClient();

  const fileBuffer = await fs.promises.readFile(filePath);
  const contentType = getContentType(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileBuffer,
      ...(acl ? { ACL: acl } : {}),
      ContentType: contentType,
    })
  );

  // Clean up local file after upload
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }

  return `https://${bucket}.${region}.digitaloceanspaces.com/${objectKey}`;
};

// Public web assets (avatars, logos, email assets). Object is world-readable.
export const uploadToSpaces = (
  filePath: string,
  objectKey: string
): Promise<string> => putObjectFromFile(filePath, objectKey, "public-read");

// Private uploads (e.g. vendor-response documents). No public-read ACL —
// the object is only reachable via short-lived presigned GET URLs.
export const uploadPrivateToSpaces = (
  filePath: string,
  objectKey: string
): Promise<string> => putObjectFromFile(filePath, objectKey);

// Derive the object key from a canonical Spaces URL we generated at upload time.
export const spacesObjectKeyFromUrl = (url: string): string | null => {
  try {
    const pathname = new URL(url).pathname;
    const objectKey = decodeURIComponent(pathname.replace(/^\/+/, ""));
    return objectKey || null;
  } catch {
    return null;
  }
};

// Short-lived presigned GET URL for a private object.
export const presignSpacesGetUrl = async (
  objectKey: string,
  expiresSeconds: number
): Promise<string> => {
  const { bucket, client } = createSpacesClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: expiresSeconds }
  );
};
