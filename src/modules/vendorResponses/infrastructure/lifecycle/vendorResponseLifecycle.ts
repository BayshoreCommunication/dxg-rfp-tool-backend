import type { ProposalLifecycle } from "../../../proposalLifecycle/application";
import type { LifecycleActor } from "../../../proposalLifecycle/domain";
import type { VendorSubmissionRepository } from "../../domain/ports/vendorSubmissionRepository";
import type { VendorResponseDeleteRepository } from "../../domain/ports/vendorResponseDeleteRepository";

type Recorder = Pick<ProposalLifecycle, "record">;

// ORG-403: every vendor response, whether a vendor submitted it through the portal (legacy or
// structured) or a planner entered it by hand, is written by saveVersion; every removal by
// deleteOwnedTargets. Decorating those two methods keeps the RFP's response count and stage in
// step without each use case having to remember to.
export const withSubmissionLifecycle = <T extends VendorSubmissionRepository>(
  repository: T,
  lifecycle: Recorder,
  plannerUserId: () => string | null,
): T => ({
  ...repository,
  async saveVersion(input) {
    const saved = await repository.saveVersion.call(this, input);
    if (saved.created && input.organizationId) {
      const userId = input.sourceSystem === "planner_upload" ? plannerUserId() : null;
      const actor: LifecycleActor = userId ? { type: "user", userId } : input.sourceSystem === "planner_upload" ? { type: "system" } : { type: "vendor" };
      await lifecycle.record({
        organizationId: input.organizationId,
        proposalId: input.proposalId,
        actor,
        reason: "vendor_responded",
        recount: ["responded"],
      });
    }
    return saved;
  },
});

export const withDeletionLifecycle = <T extends VendorResponseDeleteRepository>(
  repository: T,
  lifecycle: Recorder,
): T => ({
  ...repository,
  async deleteOwnedTargets(input) {
    const deleted = await repository.deleteOwnedTargets.call(this, input);
    const proposals = new Map(
      input.targets.filter((target) => target.organizationId).map((target) => [
        `${target.organizationId}:${target.proposalId}`,
        { organizationId: target.organizationId, proposalId: target.proposalId },
      ]),
    );
    for (const ref of proposals.values()) {
      await lifecycle.record({
        ...ref,
        actor: { type: "user", userId: input.ownerUserId },
        reason: "vendor_response_deleted",
        recount: ["responded"],
      });
    }
    return deleted;
  },
});
