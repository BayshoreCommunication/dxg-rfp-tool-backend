import type { ProposalLifecycleRecorder } from "../../domain/ports/proposalLifecycleRecorder";
import { proposalLifecycle, requestOrganizationId, userActor } from "../../../proposalLifecycle/composition";

// Planner writes run inside the authenticated request's tenant context, and the write repository
// has already scoped the proposal to that organization.
export const proposalLifecycleRecorderAdapter: ProposalLifecycleRecorder = {
  async recordChange({ proposalId, actorUserId, reason }) {
    const organizationId = requestOrganizationId();
    if (!organizationId) return;
    await proposalLifecycle.record({ organizationId, proposalId, actor: userActor(actorUserId), reason });
  },
};
