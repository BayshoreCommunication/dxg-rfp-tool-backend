import mongoose from "mongoose";
import Proposal from "../../../modal/proposalsModel";
import ProposalStatusTransition from "../../../modal/proposalStatusTransitionModel";
import PublicAccessGrant from "../../../modal/publicAccessGrantModel";
import VendorResponse from "../../../modal/vendorResponseModel";
import type { LifecycleSnapshot, ProposalLifecycleRepository, ProposalRef } from "./application";
import type { ProposalLifecycleState } from "./domain";

const valid = (ref: ProposalRef) =>
  mongoose.isValidObjectId(ref.proposalId) && mongoose.isValidObjectId(ref.organizationId);

// Matches a stored value, treating a missing field and null as the same thing.
const sameAs = (value: unknown) => (value === undefined || value === null ? { $in: [null] } : value);

type StoredLifecycle = Omit<ProposalLifecycleState, "awardedByUserId"> & { awardedByUserId?: unknown };

const toState = (stored: StoredLifecycle | undefined | null): ProposalLifecycleState => ({
  ...(stored ?? {}),
  awardedByUserId: stored?.awardedByUserId ? String(stored.awardedByUserId) : null,
});

// Every caller has already authorized the action on this proposal (access policy, vendor grant,
// or a system job); each query still names the organization.
export const mongoProposalLifecycleRepository: ProposalLifecycleRepository = {
  async load(ref) {
    if (!valid(ref)) return null;
    const proposal = await Proposal.findOne({ _id: ref.proposalId, organizationId: ref.organizationId })
      .select("status isDraft isArchived lifecycle")
      .lean<{ status?: string; isDraft?: boolean; isArchived?: boolean; lifecycle?: StoredLifecycle } | null>();
    if (!proposal) return null;
    return {
      facts: { status: proposal.status ?? null, isDraft: proposal.isDraft ?? null, isArchived: proposal.isArchived ?? null },
      state: toState(proposal.lifecycle),
    };
  },

  async listTransitions(ref) {
    if (!valid(ref)) return [];
    const rows = await ProposalStatusTransition.find({ organizationId: ref.organizationId, proposalId: ref.proposalId })
      .sort({ at: 1, _id: 1 })
      .limit(500)
      .lean();
    return rows.map((row) => ({
      fromStage: row.fromStage ?? null,
      toStage: row.toStage,
      fromStatus: row.fromStatus ?? null,
      toStatus: row.toStatus ?? null,
      actorType: row.actorType,
      actorUserId: row.actorUserId ? String(row.actorUserId) : null,
      reason: row.reason,
      at: row.at,
    }));
  },

  async countVendorsResponded(ref) {
    if (!valid(ref)) return 0;
    // One VendorResponse per (proposal, vendor email): the same rows the vendor-response inbox counts.
    return VendorResponse.countDocuments({ organizationId: ref.organizationId, proposalId: ref.proposalId });
  },

  async countVendorsInvited(ref) {
    if (!valid(ref)) return 0;
    // Distinct vendors ever sent a response link. Expiry and revocation don't un-invite anyone.
    const recipients = await PublicAccessGrant.distinct("recipientHash", {
      organizationId: ref.organizationId,
      resourceId: ref.proposalId,
      purpose: "vendor:submit",
      recipientHash: { $nin: [null, ""] },
    });
    return recipients.length;
  },

  async apply({ organizationId, proposalId, expected, next, transition }) {
    const session = await mongoose.startSession();
    try {
      let applied = false;
      await session.withTransaction(async () => {
        applied = false;
        const result = await Proposal.updateOne(
          {
            _id: proposalId,
            organizationId,
            status: sameAs(expected.facts.status),
            isDraft: sameAs(expected.facts.isDraft),
            isArchived: sameAs(expected.facts.isArchived),
            "lifecycle.revision": sameAs(expected.state.revision),
          },
          { $set: { lifecycle: next } },
          { session, timestamps: false },
        );
        if (result.matchedCount !== 1) return;
        if (transition) {
          await ProposalStatusTransition.create(
            [
              {
                organizationId,
                proposalId,
                fromStage: transition.fromStage,
                toStage: transition.toStage,
                fromStatus: transition.fromStatus,
                toStatus: transition.toStatus,
                actorType: transition.actor.type,
                actorUserId: transition.actor.type === "user" ? transition.actor.userId : null,
                reason: transition.reason,
                at: transition.at,
              },
            ],
            { session },
          );
        }
        applied = true;
      });
      return applied;
    } finally {
      await session.endSession();
    }
  },
};

export type { LifecycleSnapshot };
