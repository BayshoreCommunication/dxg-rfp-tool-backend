import mongoose, { Schema, type Document } from "mongoose";
import type { ProposalV1 } from "../contracts/generated/proposal-v1";
import type {
  CanonicalMigrationStatus,
} from "../src/modules/proposals/application/canonicalMigration";
import type { LegacyMappingIssue } from "../contracts/proposal/v1/legacyAdapter";

export interface IProposalCanonicalSnapshot extends Document {
  runId: string;
  migrationRelease: string;
  legacyProposalId: mongoose.Types.ObjectId;
  legacyHash: string;
  legacyUpdatedAt?: Date | null;
  organizationId: mongoose.Types.ObjectId;
  ownerUserId: string;
  status: CanonicalMigrationStatus;
  canonicalData?: ProposalV1 | null;
  issues: LegacyMappingIssue[];
  createdAt: Date;
  updatedAt: Date;
}

const legacyMappingIssueSchema = new Schema<LegacyMappingIssue>(
  {
    path: { type: String, required: true },
    code: {
      type: String,
      enum: ["invalid", "missing", "unmapped", "normalized"],
      required: true,
    },
    message: { type: String, required: true },
  },
  { _id: false },
);

const proposalCanonicalSnapshotSchema = new Schema<IProposalCanonicalSnapshot>(
  {
    runId: { type: String, required: true, trim: true, index: true },
    migrationRelease: { type: String, required: true, trim: true },
    legacyProposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: true,
      index: true,
    },
    legacyHash: { type: String, required: true, trim: true },
    legacyUpdatedAt: { type: Date, default: null },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    ownerUserId: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["ready", "needs_review", "failed"],
      required: true,
      index: true,
    },
    canonicalData: { type: Schema.Types.Mixed, default: null },
    issues: { type: [legacyMappingIssueSchema], default: [] },
  },
  { timestamps: true },
);

proposalCanonicalSnapshotSchema.index(
  { legacyProposalId: 1, legacyHash: 1, migrationRelease: 1 },
  { unique: true },
);
proposalCanonicalSnapshotSchema.index({ organizationId: 1, runId: 1, status: 1 });

const ProposalCanonicalSnapshot = mongoose.model<IProposalCanonicalSnapshot>(
  "ProposalCanonicalSnapshot",
  proposalCanonicalSnapshotSchema,
);

export default ProposalCanonicalSnapshot;
