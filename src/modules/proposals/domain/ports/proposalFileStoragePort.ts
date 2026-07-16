export interface ProposalFileStoragePort {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
}
