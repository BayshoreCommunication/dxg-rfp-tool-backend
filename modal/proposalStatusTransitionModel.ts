import mongoose, { Document, Schema } from "mongoose";
import {
  LIFECYCLE_ACTOR_TYPES,
  LIFECYCLE_REASONS,
  LIFECYCLE_STAGES,
  type LifecycleReason,
  type LifecycleStage,
} from "../src/modules/proposalLifecycle/domain";

// ORG-403: append-only history of an RFP's lifecycle (PRD P0-10). Rows are only ever inserted;
// every update path on the model throws. They outlive a deleted proposal on purpose, as the
// record of what happened to it, and are removed only with their organization.
export interface IProposalStatusTransition extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  fromStage: LifecycleStage | null;
  toStage: LifecycleStage;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: (typeof LIFECYCLE_ACTOR_TYPES)[number];
  actorUserId: mongoose.Types.ObjectId | null;
  reason: LifecycleReason;
  at: Date;
}

const proposalStatusTransitionSchema = new Schema<IProposalStatusTransition>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: "Proposal", required: true },
    fromStage: { type: String, enum: [...LIFECYCLE_STAGES, null], default: null },
    toStage: { type: String, enum: LIFECYCLE_STAGES, required: true },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    actorType: { type: String, enum: LIFECYCLE_ACTOR_TYPES, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, enum: LIFECYCLE_REASONS, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false, collection: "proposalstatustransitions" },
);

proposalStatusTransitionSchema.index({ organizationId: 1, proposalId: 1, at: 1 });
// Reporting reads (P2-1: awarded this quarter, turnaround) scan by stage and time.
proposalStatusTransitionSchema.index({ organizationId: 1, toStage: 1, at: -1 });

const refuseUpdate = () => {
  throw new Error("Proposal status transitions are append-only");
};
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  proposalStatusTransitionSchema.pre(operation, refuseUpdate);
}
proposalStatusTransitionSchema.pre("save", function rejectResave(next) {
  if (!this.isNew) return next(new Error("Proposal status transitions are append-only"));
  next();
});

export default mongoose.model<IProposalStatusTransition>(
  "ProposalStatusTransition",
  proposalStatusTransitionSchema,
);
