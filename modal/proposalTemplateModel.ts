import mongoose, { Document, Schema } from "mongoose";

// ORG-604: a reusable snapshot of an RFP's content and presentation layout (DXG decision Q4).
// `content` is customer content: it holds only the sections src/modules/proposals/domain/templateSnapshot.ts lets through (no
// vendors, responses, dates, files or contact people) and never leaves its organization.
export const TEMPLATE_SCOPES = ["personal", "organization"] as const;
export const PRESENTATION_LAYOUTS = ["template-one", "template-two"] as const;

export interface IProposalTemplate extends Document {
  organizationId: mongoose.Types.ObjectId;
  // The member who saved it. A personal template is visible to this member only.
  ownerUserId: mongoose.Types.ObjectId;
  scope: (typeof TEMPLATE_SCOPES)[number];
  title: string;
  description: string;
  content: Record<string, unknown>;
  presentationLayout?: (typeof PRESENTATION_LAYOUTS)[number] | null;
  // Set while an organization template is published; null for personal and unpublished ones.
  publishedAt?: Date | null;
  publishedBy?: mongoose.Types.ObjectId | null;
  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const proposalTemplateSchema = new Schema<IProposalTemplate>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scope: { type: String, enum: TEMPLATE_SCOPES, required: true, default: "personal" },
    title: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    content: { type: Schema.Types.Mixed, required: true, default: {} },
    presentationLayout: { type: String, enum: [...PRESENTATION_LAYOUTS, null], default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    archived: { type: Boolean, default: false, required: true },
    archivedAt: { type: Date, default: null },
  },
  // minimize: false keeps empty sections of the snapshot instead of dropping them.
  { timestamps: true, minimize: false },
);

// The picker and the management list: one organization's templates by scope and state.
proposalTemplateSchema.index({ organizationId: 1, scope: 1, archived: 1, title: 1 });
// A member's own personal templates.
proposalTemplateSchema.index({ organizationId: 1, ownerUserId: 1, scope: 1 });

const ProposalTemplate = mongoose.model<IProposalTemplate>("ProposalTemplate", proposalTemplateSchema);
export default ProposalTemplate;
