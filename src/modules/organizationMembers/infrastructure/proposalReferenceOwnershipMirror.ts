import mongoose from "mongoose";
import Proposal from "../../../../modal/proposalsModel";
import { postgresProposalReferenceSynchronizer } from "../../proposals/infrastructure/references/postgresProposalReferenceSynchronizer";
import type { LegacyProposalRecord } from "../../proposals/application/proposalPresentation";
import type { RfpOwnershipMirror } from "../domain/ports";

// The Postgres proposal reference carries owner_user_id for the AI layer. The synchronizer is a
// no-op unless dual write is on, and logs (never throws) when it can't write.
export const proposalReferenceOwnershipMirror: RfpOwnershipMirror = {
  async afterReassign({ organizationId, rfpIds, toUserId }) {
    const proposals = await Proposal.find({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      _id: { $in: rfpIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();
    for (const proposal of proposals) {
      await postgresProposalReferenceSynchronizer.synchronize({
        proposal: proposal as unknown as LegacyProposalRecord, ownerUserId: toUserId, eventType: "proposal.reference.updated",
      });
    }
  },
};
