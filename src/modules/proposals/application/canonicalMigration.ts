import { createHash } from "node:crypto";
import type { ProposalV1 } from "../../../../contracts/generated/proposal-v1";
import {
  mapLegacyProposalToV1,
  type LegacyMappingIssue,
  type LegacyProposalContext,
} from "../../../../contracts/proposal/v1/legacyAdapter";

export const CANONICAL_PROPOSAL_MIGRATION_RELEASE = "proposal-v1.0.0";

export type CanonicalMigrationStatus = "ready" | "needs_review" | "failed";

export type CanonicalMigrationCandidate = {
  migrationRelease: typeof CANONICAL_PROPOSAL_MIGRATION_RELEASE;
  legacyProposalId: string;
  legacyHash: string;
  legacyUpdatedAt: string | null;
  status: CanonicalMigrationStatus;
  canonicalData: ProposalV1 | null;
  issues: LegacyMappingIssue[];
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

export const hashLegacyProposal = (legacyProposal: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(legacyProposal)))
    .digest("hex");

const hasReviewIssue = (issues: LegacyMappingIssue[]): boolean =>
  issues.some((issue) =>
    issue.code === "invalid" ||
    issue.code === "missing" ||
    issue.code === "unmapped",
  );

export const buildCanonicalMigrationCandidate = (
  legacyProposal: unknown,
  context: LegacyProposalContext,
): CanonicalMigrationCandidate => {
  const legacy = record(legacyProposal);
  const legacyProposalId = String(legacy._id ?? legacy.id ?? "");
  const legacyUpdatedAt =
    legacy.updatedAt instanceof Date
      ? legacy.updatedAt.toISOString()
      : typeof legacy.updatedAt === "string"
        ? legacy.updatedAt
        : null;
  const mapping = mapLegacyProposalToV1(legacyProposal, context);

  if (!mapping.success) {
    return {
      migrationRelease: CANONICAL_PROPOSAL_MIGRATION_RELEASE,
      legacyProposalId,
      legacyHash: hashLegacyProposal(legacyProposal),
      legacyUpdatedAt,
      status: "failed",
      canonicalData: null,
      issues: mapping.issues,
    };
  }

  return {
    migrationRelease: CANONICAL_PROPOSAL_MIGRATION_RELEASE,
    legacyProposalId,
    legacyHash: hashLegacyProposal(legacyProposal),
    legacyUpdatedAt,
    status: hasReviewIssue(mapping.issues) ? "needs_review" : "ready",
    canonicalData: mapping.proposal,
    issues: mapping.issues,
  };
};
