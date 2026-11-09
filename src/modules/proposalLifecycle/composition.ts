import { pseudonym, safeLog } from "../../shared/observability/safeTelemetry";
import { currentTenantOrNull } from "../shared/tenancy/tenantContext";
import { createProposalLifecycle } from "./application";
import type { LifecycleActor } from "./domain";
import { mongoProposalLifecycleRepository } from "./mongoProposalLifecycleRepository";

export const proposalLifecycle = createProposalLifecycle({
  repository: mongoProposalLifecycleRepository,
  onSyncFailure: (error, input) => {
    safeLog("warn", "proposal_lifecycle_sync_failed", {
      organizationPseudonym: pseudonym(input.organizationId),
      proposalPseudonym: pseudonym(input.proposalId),
      operation: input.reason,
      errorCode: (error as { code?: string } | null)?.code ?? "UNKNOWN",
      outcome: "failure",
    });
  },
});

// The organization of the current authenticated request. Proposal write paths run inside it, and
// their repositories already scope every query to it.
export const requestOrganizationId = (): string | null => currentTenantOrNull()?.organizationId ?? null;

export const userActor = (userId: string): LifecycleActor => ({ type: "user", userId });
