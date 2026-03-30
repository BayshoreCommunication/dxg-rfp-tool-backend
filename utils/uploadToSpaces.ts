import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

type SpacesConfig = {
  bucket: string;
  region: string;
  key: string;
  secret: string;
  folder: string;
};

const contentTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
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

export const uploadToSpaces = async (
  filePath: string,
  objectKey: string
): Promise<string> => {
  const { bucket, region, key, secret } = getSpacesConfig();

  const client = new S3Client({
    region,
    endpoint: `https://${region}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId: key,
      secretAccessKey: secret,
    },
  });

  const fileBuffer = await fs.promises.readFile(filePath);
  const contentType = getContentType(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fileBuffer,
      ACL: "public-read",
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
