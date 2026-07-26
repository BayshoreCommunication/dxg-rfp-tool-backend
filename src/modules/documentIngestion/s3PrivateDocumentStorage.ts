import { DeleteObjectCommand, GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DocumentIngestionError } from "./domain";
import type { PrivateDocumentStorage } from "./ports";

const configuration = () => {
  const bucket = process.env.DOCUMENT_STORAGE_BUCKET || process.env.DO_SPACES_BUCKET;
  const region = process.env.DOCUMENT_STORAGE_REGION || process.env.DO_SPACES_REGION;
  const key = process.env.DOCUMENT_STORAGE_KEY || process.env.DO_SPACES_KEY;
  const secret = process.env.DOCUMENT_STORAGE_SECRET || process.env.DO_SPACES_SECRET;
  const endpoint = process.env.DOCUMENT_STORAGE_ENDPOINT || (region ? `https://${region}.digitaloceanspaces.com` : undefined);
  if (!bucket || !region || !key || !secret || !endpoint) throw new DocumentIngestionError("STORAGE_UNAVAILABLE", "Private document storage is not configured.", 503);
  return { bucket, client: new S3Client({ region, endpoint, forcePathStyle: process.env.DOCUMENT_STORAGE_FORCE_PATH_STYLE === "true", credentials: { accessKeyId: key, secretAccessKey: secret } }) };
};

export const s3PrivateDocumentStorage: PrivateDocumentStorage = {
  async createUpload(input) {
    const { bucket, client } = configuration();
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: input.objectKey, ContentType: input.contentType, ContentLength: input.sizeBytes }), { expiresIn: input.expiresSeconds });
    return { uploadUrl, expiresAt: new Date(Date.now() + input.expiresSeconds * 1000).toISOString() };
  },
  async read(input) {
    const { bucket, client } = configuration();
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: input.objectKey }));
    if (!response.Body) throw new DocumentIngestionError("OBJECT_NOT_FOUND", "Uploaded object was not found.", 404);
    if (response.ContentLength && response.ContentLength > input.maxBytes) throw new DocumentIngestionError("FILE_SIZE_INVALID", "Uploaded file exceeds the configured limit.", 413);
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    if (bytes.length > input.maxBytes) throw new DocumentIngestionError("FILE_SIZE_INVALID", "Uploaded file exceeds the configured limit.", 413);
    return { bytes, sizeBytes: bytes.length, versionId: response.VersionId };
  },
  async delete(objectKey) {
    const { bucket, client } = configuration();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  },
};

