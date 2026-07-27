import { uploadPrivateToSpaces } from "../../../../../utils/uploadToSpaces";
import type { ProposalFileStoragePort } from "../../domain/ports/proposalFileStoragePort";

/**
 * Support documents and AV quotes are the planner's own commercial material,
 * so they are stored WITHOUT the public-read ACL and are reachable only via
 * the short-lived presigned URLs issued by proposalFileAccess.
 */
export const spacesProposalFileStorage: ProposalFileStoragePort = {
  upload({ localPath, objectKey }) {
    return uploadPrivateToSpaces(localPath, objectKey);
  },
};
