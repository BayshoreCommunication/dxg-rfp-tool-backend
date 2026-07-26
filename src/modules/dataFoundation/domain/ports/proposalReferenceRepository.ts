export type ProposalReferenceInput = {
  organizationMongoId: string;
  ownerUserMongoId: string;
  proposalMongoId: string;
  sourceVersion?: string;
  sourceChecksum?: string;
  sourceUpdatedAt?: Date;
  correlationId: string;
  eventType: "proposal.reference.backfilled" | "proposal.reference.updated";
};

export interface ProposalReferenceRepository {
  upsertWithOutbox(input: ProposalReferenceInput): Promise<{ proposalReferenceId: string; outboxEventId: string; referenceCreated: boolean; outboxCreated: boolean }>;
}
