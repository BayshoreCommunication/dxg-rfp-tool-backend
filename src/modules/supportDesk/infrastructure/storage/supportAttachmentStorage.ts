import {
  presignPrivateDocumentGetUrl,
  uploadPrivateDocumentFile,
} from "../../../documentIngestion/s3PrivateDocumentStorage";
import type { SupportAttachmentStorage } from "../../domain/ports/supportDeskPorts";

/**
 * Helpdesk attachments live in the private bucket without any public ACL;
 * the only way to read one is a short-lived presigned URL issued after the
 * ticket and message authorization checks pass.
 */
export const s3SupportAttachmentStorage: SupportAttachmentStorage = {
  async upload({ localPath, objectKey, mimeType }) {
    await uploadPrivateDocumentFile({ localPath, objectKey, contentType: mimeType });
  },
  async presignDownload(objectKey, expiresSeconds) {
    return presignPrivateDocumentGetUrl(objectKey, expiresSeconds);
  },
};
