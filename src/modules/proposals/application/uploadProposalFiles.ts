import type { ProposalFileStoragePort } from "../domain/ports/proposalFileStoragePort";
import { PROPOSAL_FILE_PRIVATE_SEGMENT } from "./proposalFileAccess";

export type ProposalUploadFile = {
  fieldname: string;
  originalname: string;
  path: string;
};

const safeObjectName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_");

export const createUploadProposalFiles = (dependencies: {
  storage: ProposalFileStoragePort;
  folderName: string;
  now?: () => number;
}) => async (input: {
  ownerUserId: string;
  files: ProposalUploadFile[];
}) => {
  if (input.files.length === 0) return { kind: "no_files" as const };
  const now = dependencies.now ?? Date.now;
  const results: Array<{
    fieldname: string;
    originalname: string;
    url: string;
  }> = [];
  for (const [index, file] of input.files.entries()) {
    const objectKey = [
      dependencies.folderName,
      // The private segment marks the object as one that must be presigned to
      // read, and the owner id that follows is what authorizes that presign.
      PROPOSAL_FILE_PRIVATE_SEGMENT,
      input.ownerUserId,
      `${now()}-${index}-${safeObjectName(file.originalname)}`,
    ].join("/");
    const url = await dependencies.storage.upload({
      localPath: file.path,
      objectKey,
    });
    results.push({
      fieldname: file.fieldname,
      originalname: file.originalname,
      url,
    });
  }
  return { kind: "uploaded" as const, files: results };
};
