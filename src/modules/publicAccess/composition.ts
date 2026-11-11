import { createPublicAccessManager } from "./application/managePublicAccess";
import { mongoPublicAccessRepository } from "./infrastructure/mongoPublicAccessRepository";
import { proposalLifecycle } from "../proposalLifecycle/composition";

export const publicAccess = createPublicAccessManager(mongoPublicAccessRepository, async (input) => {
  await proposalLifecycle.record({
    organizationId: input.organizationId,
    proposalId: input.proposalId,
    actor: { type: "user", userId: input.createdByUserId },
    reason: "vendor_invited",
    recount: ["invited"],
  });
});
