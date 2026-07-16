import mongoose from "mongoose";
import Proposal from "../../../../../modal/proposalsModel";
import ProposalCanonicalSnapshot from "../../../../../modal/proposalCanonicalSnapshotModel";
import {
  buildCanonicalMigrationCandidate,
  type CanonicalMigrationCandidate,
} from "../../application/canonicalMigration";

export type CanonicalMigrationOptions = {
  organizationId: string;
  sourceOwnerUserId: string;
  runId: string;
  apply: boolean;
  limit?: number;
  afterId?: string;
};

export type CanonicalMigrationSummary = {
  runId: string;
  mode: "dry_run" | "apply";
  scanned: number;
  ready: number;
  needsReview: number;
  failed: number;
  inserted: number;
  alreadyPresent: number;
  lastProposalId: string | null;
  candidates: CanonicalMigrationCandidate[];
};

type LegacyProposalRecord = {
  _id: { toString(): string };
  userId?: { toString(): string } | null;
  [key: string]: unknown;
};

export type CanonicalMigrationDependencies = {
  findLegacyProposals(options: {
    sourceOwnerUserId: string;
    afterId?: string;
    limit: number;
  }): Promise<LegacyProposalRecord[]>;
  insertSnapshotIfAbsent(input: {
    runId: string;
    organizationId: string;
    proposal: LegacyProposalRecord;
    candidate: CanonicalMigrationCandidate;
  }): Promise<boolean>;
  countSnapshots(filter: { organizationId: string; runId: string }): Promise<number>;
  deleteSnapshots(filter: { organizationId: string; runId: string }): Promise<number>;
};

const safeLimit = (value?: number): number =>
  Math.min(1000, Math.max(1, Number.isInteger(value) ? (value as number) : 100));

const defaultDependencies: CanonicalMigrationDependencies = {
  async findLegacyProposals({ sourceOwnerUserId, afterId, limit }) {
    const filter = {
      userId: new mongoose.Types.ObjectId(sourceOwnerUserId),
      ...(afterId ? { _id: { $gt: new mongoose.Types.ObjectId(afterId) } } : {}),
    };
    return Proposal.find(filter)
      .sort({ _id: 1 })
      .limit(limit)
      .lean() as unknown as Promise<LegacyProposalRecord[]>;
  },
  async insertSnapshotIfAbsent({ runId, organizationId, proposal, candidate }) {
    const result = await ProposalCanonicalSnapshot.updateOne(
      {
        legacyProposalId: proposal._id,
        legacyHash: candidate.legacyHash,
        migrationRelease: candidate.migrationRelease,
      },
      {
        $setOnInsert: {
          runId,
          migrationRelease: candidate.migrationRelease,
          legacyProposalId: proposal._id,
          legacyHash: candidate.legacyHash,
          legacyUpdatedAt: candidate.legacyUpdatedAt
            ? new Date(candidate.legacyUpdatedAt)
            : null,
          organizationId,
          ownerUserId: proposal.userId?.toString() ?? "legacy-unknown-owner",
          status: candidate.status,
          canonicalData: candidate.canonicalData,
          issues: candidate.issues,
        },
      },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  },
  countSnapshots: (filter) => ProposalCanonicalSnapshot.countDocuments(filter),
  async deleteSnapshots(filter) {
    const result = await ProposalCanonicalSnapshot.deleteMany(filter);
    return result.deletedCount;
  },
};

export const migrateLegacyProposalBatch = async (
  options: CanonicalMigrationOptions,
  dependencies: CanonicalMigrationDependencies = defaultDependencies,
): Promise<CanonicalMigrationSummary> => {
  if (!options.organizationId.trim()) throw new Error("organizationId is required");
  if (!mongoose.isValidObjectId(options.sourceOwnerUserId)) {
    throw new Error("sourceOwnerUserId must be a valid MongoDB ObjectId");
  }
  if (!options.runId.trim()) throw new Error("runId is required");
  if (options.afterId && !mongoose.isValidObjectId(options.afterId)) {
    throw new Error("afterId must be a valid MongoDB ObjectId");
  }

  const proposals = await dependencies.findLegacyProposals({
    sourceOwnerUserId: options.sourceOwnerUserId,
    afterId: options.afterId,
    limit: safeLimit(options.limit),
  });

  const summary: CanonicalMigrationSummary = {
    runId: options.runId,
    mode: options.apply ? "apply" : "dry_run",
    scanned: 0,
    ready: 0,
    needsReview: 0,
    failed: 0,
    inserted: 0,
    alreadyPresent: 0,
    lastProposalId: null,
    candidates: [],
  };

  for (const proposal of proposals) {
    const candidate = buildCanonicalMigrationCandidate(proposal, {
      organizationId: options.organizationId,
      ownerUserId: proposal.userId?.toString(),
    });
    summary.scanned += 1;
    summary.lastProposalId = proposal._id.toString();
    summary.candidates.push(candidate);
    if (candidate.status === "ready") summary.ready += 1;
    if (candidate.status === "needs_review") summary.needsReview += 1;
    if (candidate.status === "failed") summary.failed += 1;

    if (!options.apply) continue;

    const inserted = await dependencies.insertSnapshotIfAbsent({
      runId: options.runId,
      organizationId: options.organizationId,
      proposal,
      candidate,
    });
    if (inserted) summary.inserted += 1;
    else summary.alreadyPresent += 1;
  }

  return summary;
};

export const rollbackCanonicalMigrationRun = async (options: {
  organizationId: string;
  runId: string;
  apply: boolean;
}, dependencies: CanonicalMigrationDependencies = defaultDependencies): Promise<{
  mode: "dry_run" | "apply";
  matched: number;
  deleted: number;
}> => {
  const filter = {
    organizationId: options.organizationId,
    runId: options.runId,
  };
  const matched = await dependencies.countSnapshots(filter);
  if (!options.apply) return { mode: "dry_run", matched, deleted: 0 };
  const deleted = await dependencies.deleteSnapshots(filter);
  return { mode: "apply", matched, deleted };
};
