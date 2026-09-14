import mongoose, { Schema, type Document, type Query } from "mongoose";
import type { VendorResponseQuestionnaireV1 } from "../contracts/generated/vendor-response-questionnaire-v1";

export type VendorResponseQuestionnaireLifecycleStatus = "published" | "superseded";

export interface IVendorResponseQuestionnaireVersion extends Document {
  organizationId: mongoose.Types.ObjectId;
  proposalId: mongoose.Types.ObjectId;
  proposalVersion: number;
  questionnaireId: string;
  questionnaireVersion: number;
  questionnaireChecksum: string;
  sourceChecksum: string;
  schemaVersion: "vendor-response-questionnaire.v1";
  projectionVersion: string;
  status: VendorResponseQuestionnaireLifecycleStatus;
  questionnaire: VendorResponseQuestionnaireV1;
  publishedByActorId: string;
  publishedAt: Date;
  supersededAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const checksum = {
  type: String,
  required: true,
  trim: true,
  validate: {
    validator: (value: string) => /^[0-9a-f]{64}$/.test(value),
    message: "Questionnaire checksum must be SHA-256",
  },
} as const;

const questionnaireVersionSchema = new Schema<IVendorResponseQuestionnaireVersion>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    proposalId: {
      type: Schema.Types.ObjectId,
      ref: "Proposal",
      required: true,
      index: true,
    },
    proposalVersion: { type: Number, required: true, min: 1 },
    questionnaireId: { type: String, required: true, trim: true },
    questionnaireVersion: { type: Number, required: true, min: 1 },
    questionnaireChecksum: checksum,
    sourceChecksum: checksum,
    schemaVersion: {
      type: String,
      enum: ["vendor-response-questionnaire.v1"],
      required: true,
    },
    projectionVersion: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["published", "superseded"],
      required: true,
      index: true,
    },
    questionnaire: { type: Schema.Types.Mixed, required: true },
    publishedByActorId: { type: String, required: true, trim: true },
    publishedAt: { type: Date, required: true },
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true },
);

questionnaireVersionSchema.index(
  { organizationId: 1, proposalId: 1, questionnaireVersion: 1 },
  { unique: true },
);
questionnaireVersionSchema.index(
  { organizationId: 1, proposalId: 1, sourceChecksum: 1 },
);
questionnaireVersionSchema.index({ proposalId: 1, questionnaireVersion: -1 });

questionnaireVersionSchema.pre("save", function rejectPublishedContentMutation() {
  if (!this.isNew) throw new Error("Published vendor response questionnaires are immutable");
});

const lifecycleFields = new Set(["status", "supersededAt"]);
questionnaireVersionSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate"],
  function allowLifecycleTransitionOnly(
    this: Query<unknown, IVendorResponseQuestionnaireVersion>,
  ) {
    const update = this.getUpdate() as Record<string, unknown> | null;
    const set = update?.$set && typeof update.$set === "object"
      ? (update.$set as Record<string, unknown>)
      : {};
    const rootKeys = Object.keys(update ?? {}).filter((key) => !key.startsWith("$"));
    const operatorKeys = Object.keys(update ?? {}).filter(
      (key) => key.startsWith("$") && key !== "$set",
    );
    const changed = [...rootKeys, ...operatorKeys, ...Object.keys(set)];
    if (changed.some((key) => !lifecycleFields.has(key))) {
      throw new Error("Published vendor response questionnaire content is immutable");
    }
  },
);

questionnaireVersionSchema.pre(
  ["replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"],
  function rejectPublishedQuestionnaireReplacement() {
    throw new Error("Published vendor response questionnaires are immutable");
  },
);

const VendorResponseQuestionnaireVersion =
  mongoose.models.VendorResponseQuestionnaireVersion
  ?? mongoose.model<IVendorResponseQuestionnaireVersion>(
    "VendorResponseQuestionnaireVersion",
    questionnaireVersionSchema,
  );

export default VendorResponseQuestionnaireVersion;
