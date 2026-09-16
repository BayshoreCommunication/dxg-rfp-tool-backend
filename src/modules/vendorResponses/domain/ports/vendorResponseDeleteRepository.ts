export type VendorResponseDeletionTarget = {
  responseId: string;
  proposalId: string;
  organizationId: string;
  ownerUserId: string;
  submissionId: string | null;
  versionIds: string[];
  objectKeys: string[];
  sourceIds: string[];
};

export interface VendorResponseDeleteRepository {
  findOwnedDeletionTarget(input: {
    responseId: string;
    ownerUserId: string;
  }): Promise<VendorResponseDeletionTarget | null>;
  listOwnedDeletionTargets(input: {
    ownerUserId: string;
    responseIds: string[];
  }): Promise<VendorResponseDeletionTarget[]>;
  deleteOwnedTargets(input: {
    ownerUserId: string;
    targets: VendorResponseDeletionTarget[];
  }): Promise<number>;
}
