import { DeleteObjectCommand, GetObjectCommand, S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DocumentIngestionError } from "./domain";
import type { PrivateDocumentStorage } from "./ports";

const configuration = () => {
  const explicitBucket = process.env.DOCUMENT_STORAGE_BUCKET;
  const bucket = explicitBucket || process.env.DO_SPACES_BUCKET;
  const region = process.env.DOCUMENT_STORAGE_REGION || process.env.DO_SPACES_REGION;
  const key = process.env.DOCUMENT_STORAGE_KEY || process.env.DO_SPACES_KEY;
  const secret = process.env.DOCUMENT_STORAGE_SECRET || process.env.DO_SPACES_SECRET;
  // An explicit endpoint always wins. The DigitalOcean endpoint is derived
  // only for the legacy DO_SPACES_* fallback; when DOCUMENT_STORAGE_BUCKET is
  // set and no endpoint is given, the SDK targets native AWS S3.
  const endpoint =
    process.env.DOCUMENT_STORAGE_ENDPOINT ||
    (!explicitBucket && region ? `https://${region}.digitaloceanspaces.com` : undefined);
  // Static credentials when both parts are present. With neither, a
  // DOCUMENT_STORAGE_* deployment uses the SDK default provider chain (ECS
  // task role / instance profile). A lone key or secret, or the DO_SPACES_*
  // fallback without static credentials, stays fail-closed.
  const staticCredentials = key && secret ? { accessKeyId: key, secretAccessKey: secret } : undefined;
  const partialCredentials = Boolean(key) !== Boolean(secret);
  if (!bucket || !region || partialCredentials || (!staticCredentials && !explicitBucket)) {
    throw new DocumentIngestionError("STORAGE_UNAVAILABLE", "Private document storage is not configured.", 503);
  }
  return {
    bucket,
    client: new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.DOCUMENT_STORAGE_FORCE_PATH_STYLE === "true",
      ...(staticCredentials ? { credentials: staticCredentials } : {}),
    }),
  };
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

