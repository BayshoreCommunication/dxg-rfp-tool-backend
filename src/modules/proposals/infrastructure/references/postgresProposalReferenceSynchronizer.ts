import crypto from "node:crypto";
import type { ProposalReferenceSynchronizer } from "../../domain/ports/proposalReferenceSynchronizer";
import { synchronizeProposalReference } from "../../../dataFoundation/composition";
import { currentTenant } from "../../../shared/tenancy/tenantContext";
import { activeProposalWorkflowFingerprintContent } from "../../domain/workflowSections";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
};
const checksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export const postgresProposalReferenceSynchronizer: ProposalReferenceSynchronizer = {
  async synchronize({ proposal, ownerUserId, eventType }) {
    if (process.env.POSTGRES_FOUNDATION_ENABLED !== "true" || process.env.PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED !== "true") return;
    const record = proposal as unknown as Record<string, unknown>;
    const activeRecord = activeProposalWorkflowFingerprintContent(record);
    const proposalId = String(record._id ?? "");
    const activeChecksum = checksum(activeRecord);
    try {
      const tenant = currentTenant();
      const result = await synchronizeProposalReference({
        organizationMongoId: tenant.organizationId,
        ownerUserMongoId: ownerUserId,
        proposalMongoId: proposalId,
        sourceVersion: activeChecksum,
        sourceChecksum: activeChecksum,
        correlationId: `proposal-write:${proposalId}`,
        eventType,
      });
      if (result.kind !== "synchronized") throw new Error(result.kind);
    } catch (error) {
      // MongoDB remains authoritative. Reconciliation repairs a failed secondary write.
      console.error("Proposal reference synchronization deferred", {
        proposalId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  },
};
