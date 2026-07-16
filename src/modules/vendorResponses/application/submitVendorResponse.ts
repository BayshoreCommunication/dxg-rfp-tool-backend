import type {
  VendorSubmissionRepository,
  VendorDocument,
} from "../domain/ports/vendorSubmissionRepository";
import type {
  VendorConfirmationSender,
  VendorDocumentStorage,
  VendorResponseNotifier,
} from "../domain/ports/vendorSubmissionPorts";

export type VendorUpload = { originalname: string; path: string };

const required = (
  value: unknown,
  field: "vendorName" | "submittedBy" | "email",
) =>
  typeof value === "string" && value.trim()
    ? null
    : ({ kind: "invalid" as const, field });

export const createCheckVendorResponse = (
  repository: VendorSubmissionRepository,
) => async (input: {
  proposalId?: string;
  email?: string;
  trackingId?: string;
}) => {
  const trackingId = input.trackingId?.trim();
  const existing = trackingId
    ? await repository.findByTrackingId(trackingId)
    : input.proposalId && input.email?.trim()
      ? await repository.findByProposalAndEmail({
          proposalId: input.proposalId,
          email: input.email.trim().toLowerCase(),
        })
      : null;
  return { alreadySubmitted: Boolean(existing), existingResponse: existing };
};

export const createSubmitVendorResponse = (dependencies: {
  repository: VendorSubmissionRepository;
  storage: VendorDocumentStorage;
  notifier: VendorResponseNotifier;
  confirmation: VendorConfirmationSender;
  folderName: string;
  now?: () => number;
}) => async (input: {
  proposalId: string;
  vendorName: unknown;
  submittedBy: unknown;
  email: unknown;
  message?: unknown;
  trackingId?: unknown;
  files: VendorUpload[];
}) => {
  for (const [value, field] of [
    [input.vendorName, "vendorName"],
    [input.submittedBy, "submittedBy"],
    [input.email, "email"],
  ] as const) {
    const error = required(value, field);
    if (error) return error;
  }
  const vendorName = (input.vendorName as string).trim();
  const submittedBy = (input.submittedBy as string).trim();
  const email = (input.email as string).trim().toLowerCase();
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const trackingId =
    typeof input.trackingId === "string" && input.trackingId.trim()
      ? input.trackingId.trim()
      : null;
  const folder = dependencies.folderName.replace(/^\/+|\/+$/g, "") || "rfp-tool";
  const documents: VendorDocument[] = [];
  for (const [index, file] of input.files.entries()) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `${folder}/vendor-responses/${input.proposalId}/${
      (dependencies.now ?? Date.now)()
    }-${index}-${safeName}`;
    try {
      const url = await dependencies.storage.upload({
        localPath: file.path,
        objectKey,
      });
      documents.push({ name: file.originalname, url });
    } catch {
      await dependencies.storage.cleanup(file.path);
    }
  }

  const existing = await dependencies.repository.findExisting({
    proposalId: input.proposalId,
    email,
    trackingId,
  });
  if (existing) {
    const response = await dependencies.repository.updateExisting({
      responseId: String(existing._id),
      vendorName,
      submittedBy,
      message,
      documents,
      trackingId,
    });
    void dependencies.confirmation.send({
      email,
      vendorName,
      submittedBy,
      proposalTitle: existing.proposalTitle || "Untitled Proposal",
      isUpdate: true,
    });
    return { kind: "updated" as const, response };
  }

  const proposal = await dependencies.repository.findProposal(input.proposalId);
  if (!proposal) return { kind: "proposal_not_found" as const };
  const response = await dependencies.repository.create({
    ...proposal,
    vendorName,
    submittedBy,
    email,
    message,
    documents,
    trackingId,
  });
  await dependencies.notifier.notifyPlanner({
    ...proposal,
    responseId: String(response._id),
    vendorName,
    submittedBy,
    email,
  });
  void dependencies.confirmation.send({
    email,
    vendorName,
    submittedBy,
    proposalTitle: proposal.proposalTitle,
    isUpdate: false,
  });
  return { kind: "created" as const, response };
};
