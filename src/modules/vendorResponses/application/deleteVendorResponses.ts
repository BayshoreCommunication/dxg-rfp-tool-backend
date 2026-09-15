import type {
  VendorResponseDeleteRepository,
  VendorResponseDeletionTarget,
} from "../domain/ports/vendorResponseDeleteRepository";

export type PurgeVendorResponseArtifacts = (
  targets: VendorResponseDeletionTarget[],
) => Promise<void>;

export const createDeleteOwnedVendorResponse = (
  repository: VendorResponseDeleteRepository,
  purgeArtifacts: PurgeVendorResponseArtifacts,
) => async (input: { responseId: string; ownerUserId: string }) => {
  const target = await repository.findOwnedDeletionTarget(input);
  if (!target) return { kind: "not_found" as const };

  await purgeArtifacts([target]);
  const deletedCount = await repository.deleteOwnedTargets({
    ownerUserId: input.ownerUserId,
    targets: [target],
  });
  return deletedCount === 1
    ? { kind: "deleted" as const, deletedCount }
    : { kind: "not_found" as const };
};

export const createDeleteSelectedOwnedVendorResponses = (
  repository: VendorResponseDeleteRepository,
  purgeArtifacts: PurgeVendorResponseArtifacts,
) => async (input: { ownerUserId: string; responseIds: string[] }) => {
  const targets = await repository.listOwnedDeletionTargets(input);
  if (targets.length !== input.responseIds.length) {
    return { kind: "not_found" as const };
  }

  await purgeArtifacts(targets);
  const deletedCount = await repository.deleteOwnedTargets({
    ownerUserId: input.ownerUserId,
    targets,
  });
  return { kind: "deleted" as const, deletedCount };
};
