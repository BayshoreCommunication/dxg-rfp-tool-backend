import VendorResponse from "../../../../../modal/vendorResponseModel";
import VendorSubmission from "../../../../../modal/vendorSubmissionModel";
import VendorSubmissionVersion from "../../../../../modal/vendorSubmissionVersionModel";
import { spacesObjectKeyFromUrl } from "../../../../../utils/uploadToSpaces";
import type {
  VendorResponseDeleteRepository,
  VendorResponseDeletionTarget,
} from "../../domain/ports/vendorResponseDeleteRepository";
import { governedVendorObjectKey } from "../storage/spacesVendorDocumentStorage";
import { currentTenant } from "../../../shared/tenancy/tenantContext";
import { explainVendorRecordMiss, vendorRecordScope } from "../../../identity/application/proposalAccess";

type StoredDocument = {
  objectKey?: unknown;
  sourceId?: unknown;
  url?: unknown;
};

type StoredResponse = {
  _id: unknown;
  proposalId: unknown;
  organizationId: unknown;
  proposalOwnerId: unknown;
  submissionId?: unknown;
  documents?: StoredDocument[];
};

type StoredVersion = {
  _id: unknown;
  submissionId: unknown;
  documents?: StoredDocument[];
};

const strings = (values: unknown[]) =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];

const objectKey = (document: StoredDocument) => {
  if (typeof document.objectKey === "string" && document.objectKey) {
    return document.objectKey;
  }
  if (typeof document.url !== "string" || !document.url) return null;
  return governedVendorObjectKey(document.url) ?? spacesObjectKeyFromUrl(document.url);
};

const deletionTargets = async (responses: StoredResponse[]) => {
  const submissionIds = strings(
    responses.map((response) => response.submissionId && String(response.submissionId)),
  );
  const organizationIds = strings(
    responses.map((response) => String(response.organizationId)),
  );
  const versions = submissionIds.length
    ? await VendorSubmissionVersion.find({
        submissionId: { $in: submissionIds },
        organizationId: { $in: organizationIds },
      })
        .select("_id submissionId documents")
        .lean<StoredVersion[]>()
    : [];
  const versionsBySubmission = new Map<string, StoredVersion[]>();
  for (const version of versions) {
    const key = String(version.submissionId);
    const entries = versionsBySubmission.get(key) ?? [];
    entries.push(version);
    versionsBySubmission.set(key, entries);
  }

  return responses.map((response): VendorResponseDeletionTarget => {
    const submissionId = response.submissionId
      ? String(response.submissionId)
      : null;
    const responseVersions = submissionId
      ? versionsBySubmission.get(submissionId) ?? []
      : [];
    const documents = [
      ...(response.documents ?? []),
      ...responseVersions.flatMap((version) => version.documents ?? []),
    ];
    return {
      responseId: String(response._id),
      proposalId: String(response.proposalId),
      organizationId: String(response.organizationId),
      ownerUserId: String(response.proposalOwnerId),
      submissionId,
      versionIds: responseVersions.map((version) => String(version._id)),
      objectKeys: strings(documents.map(objectKey)),
      sourceIds: strings(documents.map((document) => document.sourceId)),
    };
  });
};

// Deleting vendor data needs the proposal's delete permission (ORG-102); the scope covers
// responses and submissions alike through their proposalId.
const actingUser = (ownerUserId: string) => ({ organizationId: currentTenant().organizationId, userId: ownerUserId });
const deleteScope = (ownerUserId: string) => vendorRecordScope(actingUser(ownerUserId), "delete");

export const mongoVendorResponseDeleteRepository: VendorResponseDeleteRepository = {
  async findOwnedDeletionTarget({ responseId, ownerUserId }) {
    const response = await VendorResponse.findOne({ $and: [{ _id: responseId }, await deleteScope(ownerUserId)] }) // tenant-scoped: deleteScope
      .select("_id proposalId organizationId proposalOwnerId submissionId documents")
      .lean<StoredResponse>();
    if (!response) {
      await explainVendorRecordMiss(actingUser(ownerUserId), VendorResponse, responseId, "delete");
      return null;
    }
    return (await deletionTargets([response]))[0] ?? null;
  },

  async listOwnedDeletionTargets({ ownerUserId, responseIds }) {
    const responses = await VendorResponse.find({ $and: [{ _id: { $in: responseIds } }, await deleteScope(ownerUserId)] }) // tenant-scoped: deleteScope
      .select("_id proposalId organizationId proposalOwnerId submissionId documents")
      .lean<StoredResponse[]>();
    return deletionTargets(responses);
  },

  async deleteOwnedTargets({ ownerUserId, targets }) {
    if (targets.length === 0) return 0;
    const responseIds = targets.map((target) => target.responseId);
    const submissionIds = targets.flatMap((target) =>
      target.submissionId ? [target.submissionId] : [],
    );
    const versionIds = targets.flatMap((target) => target.versionIds);
    const organizationIds = [...new Set(targets.map((target) => target.organizationId))];

    if (versionIds.length > 0) {
      await VendorSubmissionVersion.deleteMany({
        _id: { $in: versionIds },
        organizationId: { $in: organizationIds },
      });
    }
    if (submissionIds.length > 0) {
      await VendorSubmission.deleteMany({ $and: [{ _id: { $in: submissionIds } }, await deleteScope(ownerUserId)] }); // tenant-scoped: deleteScope
    }
    const result = await VendorResponse.deleteMany({ $and: [{ _id: { $in: responseIds } }, await deleteScope(ownerUserId)] }); // tenant-scoped: deleteScope
    return result.deletedCount;
  },
};
