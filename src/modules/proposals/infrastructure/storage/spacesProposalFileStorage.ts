import { uploadToSpaces } from "../../../../../utils/uploadToSpaces";
import type { ProposalFileStoragePort } from "../../domain/ports/proposalFileStoragePort";

export const spacesProposalFileStorage: ProposalFileStoragePort = {
  upload({ localPath, objectKey }) {
    return uploadToSpaces(localPath, objectKey);
  },
};
