import mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import VendorResponse from "../../../../../modal/vendorResponseModel";
import type { VendorSubmissionRepository } from "../../domain/ports/vendorSubmissionRepository";

const PUBLIC_RESPONSE_SELECT =
  "_id vendorName submittedBy email message documents proposalTitle createdAt updatedAt";

export const mongoVendorSubmissionRepository: VendorSubmissionRepository = {
  findByTrackingId(trackingId) {
    return VendorResponse.findOne({ emailTrackingId: trackingId })
      .select(PUBLIC_RESPONSE_SELECT)
      .lean();
  },

  findByProposalAndEmail({ proposalId, email }) {
    return VendorResponse.findOne({
      proposalId: new mongoose.Types.ObjectId(proposalId),
      email,
    })
      .select(PUBLIC_RESPONSE_SELECT)
      .lean();
  },

  findExisting({ proposalId, email, trackingId }) {
    const conditions: Record<string, unknown>[] = [
      { proposalId: new mongoose.Types.ObjectId(proposalId), email },
    ];
    if (trackingId) conditions.push({ emailTrackingId: trackingId });
    return VendorResponse.findOne({ $or: conditions }).lean();
  },

  async updateExisting({
    responseId,
    vendorName,
    submittedBy,
    message,
    documents,
    trackingId,
  }) {
    const response = await VendorResponse.findById(responseId);
    if (!response) throw new Error("Vendor response disappeared during update");
    response.vendorName = vendorName;
    response.submittedBy = submittedBy;
    response.message = message;
    if (documents.length) response.documents.push(...documents);
    if (trackingId && response.emailTrackingId !== trackingId) {
      response.emailTrackingId = trackingId;
    }
    await response.save();
    return response.toObject();
  },

  async findProposal(proposalId) {
    const proposal = await Proposal.findById(proposalId)
      .select("_id organizationId userId event.eventName")
      .lean();
    if (!proposal) return null;
    return {
      proposalId: String(proposal._id),
      organizationId: String(proposal.organizationId ?? ""),
      ownerUserId: String(proposal.userId ?? ""),
      proposalTitle: proposal.event?.eventName?.trim() || "Untitled Proposal",
    };
  },

  async create(input) {
    const response = await VendorResponse.create({
      organizationId: input.organizationId,
      proposalId: input.proposalId,
      proposalOwnerId: input.ownerUserId,
      proposalTitle: input.proposalTitle,
      vendorName: input.vendorName,
      submittedBy: input.submittedBy,
      email: input.email,
      message: input.message,
      documents: input.documents,
      ...(input.trackingId ? { emailTrackingId: input.trackingId } : {}),
    });
    return response.toObject();
  },
};
