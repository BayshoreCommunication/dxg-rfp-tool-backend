import { createGetOwnedProposal } from "./application/getOwnedProposal";
import { createListOwnedProposals } from "./application/listOwnedProposals";
import { createUploadProposalFiles } from "./application/uploadProposalFiles";
import { vendorUploadMalwareScan } from "../vendorResponses/infrastructure/security/vendorUploadMalwareScan";
import { createPresignProposalFile } from "./application/proposalFileAccess";
import { presignSpacesGetUrl, spacesObjectKeyFromUrl } from "../../../utils/uploadToSpaces";
import {
  createGetProposalByLegacyPublicId,
  createIncrementLegacyPublicProposalViews,
  createIncrementOwnedProposalViews,
} from "./application/accessProposalViews";
import {
  createCopyOwnedProposal,
  createCreateOwnedProposal,
  createCreateProposalFromTemplate,
  createUpdateOwnedProposal,
} from "./application/authorOwnedProposal";
import {
  createArchiveOwnedProposal,
  createPermanentlyDeleteOwnedProposal,
  createRestoreOwnedProposal,
  createUpdateOwnedProposalMeta,
  createUpdateOwnedProposalStatus,
} from "./application/mutateOwnedProposal";
import { mongoProposalReadRepository } from "./infrastructure/mongo/mongoProposalReadRepository";
import { mongoProposalSettingsRepository } from "./infrastructure/mongo/mongoProposalSettingsRepository";
import { mongoProposalWriteRepository } from "./infrastructure/mongo/mongoProposalWriteRepository";
import { mongoPublicProposalAccessRepository } from "./infrastructure/mongo/mongoPublicProposalAccessRepository";
import { mongoProposalTeamAssignment } from "./infrastructure/mongo/mongoProposalTeamAssignment";
import { proposalNotificationAdapter } from "./infrastructure/notifications/proposalNotificationAdapter";
import { spacesProposalFileStorage } from "./infrastructure/storage/spacesProposalFileStorage";
import { postgresProposalReferenceSynchronizer } from "./infrastructure/references/postgresProposalReferenceSynchronizer";
import { proposalLifecycleRecorderAdapter } from "./infrastructure/lifecycle/proposalLifecycleRecorderAdapter";

export const getOwnedProposal = createGetOwnedProposal({
  proposals: mongoProposalReadRepository,
  settings: mongoProposalSettingsRepository,
});

export const listOwnedProposals = createListOwnedProposals({
  proposals: mongoProposalReadRepository,
  settings: mongoProposalSettingsRepository,
});

const mutationDependencies = {
  proposals: mongoProposalWriteRepository,
  settings: mongoProposalSettingsRepository,
  references: postgresProposalReferenceSynchronizer,
  teams: mongoProposalTeamAssignment,
  lifecycle: proposalLifecycleRecorderAdapter,
};

export const updateOwnedProposalStatus =
  createUpdateOwnedProposalStatus(mutationDependencies);
export const updateOwnedProposalMeta =
  createUpdateOwnedProposalMeta(mutationDependencies);
export const archiveOwnedProposal =
  createArchiveOwnedProposal(mongoProposalWriteRepository, proposalLifecycleRecorderAdapter);
export const restoreOwnedProposal =
  createRestoreOwnedProposal(mongoProposalWriteRepository, proposalLifecycleRecorderAdapter);
// The purge is imported lazily, as the archive sweep does, so the S3 and
// Postgres clients are not pulled in merely by composing this module.
export const permanentlyDeleteOwnedProposal = createPermanentlyDeleteOwnedProposal(
  mongoProposalWriteRepository,
  async (targets) => {
    if (!targets.length) return;
    const { purgeProposalArtifacts } = await import("../dataFoundation/purgeProposalArtifacts");
    await purgeProposalArtifacts(targets);
  },
);
export const createOwnedProposal = createCreateOwnedProposal(mutationDependencies);
export const updateOwnedProposal = createUpdateOwnedProposal(mutationDependencies);
export const copyOwnedProposal = createCopyOwnedProposal(mutationDependencies);
export const createProposalFromTemplate = createCreateProposalFromTemplate(mutationDependencies);
// The RFP a template is saved from: the same view-scoped read a copy uses (ORG-604).
export const findProposalTemplateSource = (input: { proposalId: string; ownerUserId: string }) =>
  mongoProposalWriteRepository.findOwnedCopySourceById(input);

export const getProposalByLegacyPublicId = createGetProposalByLegacyPublicId({
  publicAccess: mongoPublicProposalAccessRepository,
  settings: mongoProposalSettingsRepository,
});
export const incrementLegacyPublicProposalViews =
  createIncrementLegacyPublicProposalViews({
    publicAccess: mongoPublicProposalAccessRepository,
    settings: mongoProposalSettingsRepository,
    notifications: proposalNotificationAdapter,
  });
export const incrementOwnedProposalViews = createIncrementOwnedProposalViews({
  proposals: mongoProposalWriteRepository,
  settings: mongoProposalSettingsRepository,
  notifications: proposalNotificationAdapter,
});
export const presignOwnedProposalFile = createPresignProposalFile({
  objectKeyFromUrl: spacesObjectKeyFromUrl,
  presign: presignSpacesGetUrl,
});
export const uploadOwnedProposalFiles = createUploadProposalFiles({
  storage: spacesProposalFileStorage,
  folderName: process.env.DO_FOLDER_NAME || "DXG-RFP-Tool",
  malwareScan: vendorUploadMalwareScan,
});

export const getProposalSettingsByUserId =
  mongoProposalSettingsRepository.findByUserId.bind(mongoProposalSettingsRepository);
