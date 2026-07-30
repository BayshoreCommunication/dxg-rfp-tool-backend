import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type SpacesConfig = {
  bucket: string;
  region: string;
  folder: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  publicUrlBase: string;
  applyPublicAcl: boolean;
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

/* Legacy app-asset storage (logos, avatars, proposal support documents,
   vendor-response documents). ASSET_STORAGE_* is the provider-neutral
   interface with DO_SPACES_* as its fallback, mirroring how the governed
   DOCUMENT_STORAGE_* interface works:

   - ASSET_STORAGE_BUCKET set, no endpoint → native AWS S3. Credentials may be
     omitted entirely to use the SDK default provider chain (ECS task role).
     No public-read ACL is applied unless explicitly re-enabled, because S3
     Block Public Access rejects ACL'd puts; set ASSET_STORAGE_PUBLIC_URL_BASE
     to the CDN/distribution that fronts public assets.
   - Only DO_SPACES_* set → DigitalOcean Spaces, byte-for-byte the historical
     behavior: derived endpoint, static keys required, public-read ACL on
     public assets, canonical Spaces URL returned. */
const getSpacesConfig = (): SpacesConfig => {
  const explicitBucket = process.env.ASSET_STORAGE_BUCKET;
  const bucket = explicitBucket || process.env.DO_SPACES_BUCKET || "";
  const region = process.env.ASSET_STORAGE_REGION || process.env.DO_SPACES_REGION || "";
  const key = process.env.ASSET_STORAGE_KEY || process.env.DO_SPACES_KEY || "";
  const secret = process.env.ASSET_STORAGE_SECRET || process.env.DO_SPACES_SECRET || "";
  const folder = process.env.DO_FOLDER_NAME || "";

  const endpoint =
    process.env.ASSET_STORAGE_ENDPOINT ||
    (!explicitBucket && region ? `https://${region}.digitaloceanspaces.com` : undefined);

  const partialCredentials = Boolean(key) !== Boolean(secret);
  if (!bucket || !region || partialCredentials || (!(key && secret) && !explicitBucket)) {
    throw new Error("Missing object storage configuration in environment");
  }

  const publicUrlBase =
    process.env.ASSET_STORAGE_PUBLIC_URL_BASE?.replace(/\/+$/, "") ||
    (explicitBucket
      ? `https://${bucket}.s3.${region}.amazonaws.com`
      : `https://${bucket}.${region}.digitaloceanspaces.com`);

  const applyPublicAcl = explicitBucket
    ? process.env.ASSET_STORAGE_PUBLIC_ACL === "true"
    : true;

  return {
    bucket,
    region,
    folder,
    endpoint,
    credentials: key && secret ? { accessKeyId: key, secretAccessKey: secret } : undefined,
    publicUrlBase,
    applyPublicAcl,
  };
};

const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return contentTypes[ext] || "application/octet-stream";
};

const createSpacesClient = () => {
  const config = getSpacesConfig();
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });
  return { ...config, client };
};

const putObjectFromFile = async (
  filePath: string,
  objectKey: string,
  acl?: "public-read"
): Promise<string> => {
  const { bucket, client, publicUrlBase, applyPublicAcl } = createSpacesClient();

  const fileBuffer = await fs.promises.readFile(filePath);
  const contentType = getContentType(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileBuffer,
      ...(acl && applyPublicAcl ? { ACL: acl } : {}),
      ContentType: contentType,
    })
  );

  // Clean up local file after upload
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Ignore cleanup errors
  }

  return `${publicUrlBase}/${objectKey}`;
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
