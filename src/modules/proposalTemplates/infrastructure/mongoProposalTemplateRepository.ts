import mongoose from "mongoose";
import ProposalTemplate from "../../../../modal/proposalTemplateModel";
import type {
  PresentationLayout,
  ProposalTemplateRecord,
  ProposalTemplateRepository,
  ProposalTemplateSummaryRecord,
  TemplateListQuery,
  TemplateScope,
  TemplateViewer,
} from "../domain";
import type { TemplateContent } from "../../proposals/domain/templateSnapshot";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const collation = { locale: "en", strength: 2 } as const;

type TemplateDocument = {
  _id: unknown;
  ownerUserId: unknown;
  scope: TemplateScope;
  title: string;
  description?: string;
  content?: TemplateContent;
  presentationLayout?: PresentationLayout | null;
  publishedAt?: Date | null;
  publishedBy?: unknown;
  archived?: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const baseOf = (template: TemplateDocument) => ({
  id: String(template._id),
  ownerUserId: String(template.ownerUserId),
  scope: template.scope,
  title: template.title,
  description: template.description ?? "",
  presentationLayout: template.presentationLayout ?? null,
  publishedAt: template.publishedAt ?? null,
  publishedBy: template.publishedBy ? String(template.publishedBy) : null,
  archived: template.archived === true,
  archivedAt: template.archivedAt ?? null,
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
});

const toRecord = (template: TemplateDocument): ProposalTemplateRecord => ({ ...baseOf(template), content: template.content ?? {} });

const toSummary = (template: TemplateDocument): ProposalTemplateSummaryRecord => {
  const eventName = (template.content as { event?: { eventName?: unknown } } | undefined)?.event?.eventName;
  return { ...baseOf(template), eventName: typeof eventName === "string" ? eventName : "" };
};

/* Exactly the templates the viewer may see in their organization: their own personal ones,
   published organization templates that aren't archived, and, for members who manage organization
   templates, every organization template. Another member's personal template never matches. */
const visibleTo = (viewer: TemplateViewer): Record<string, unknown> => ({
  $or: [
    { scope: "personal", ownerUserId: viewer.userId },
    viewer.managesOrganizationTemplates
      ? { scope: "organization" }
      : { scope: "organization", publishedAt: { $ne: null }, archived: false },
  ],
});

const listConditions = (viewer: TemplateViewer, query: TemplateListQuery): Record<string, unknown>[] => {
  const conditions: Record<string, unknown>[] = [visibleTo(viewer)];
  if (query.scope !== "all") conditions.push({ scope: query.scope });
  if (query.status !== "all") conditions.push({ archived: query.status === "archived" });
  if (query.search) {
    const contains = { $regex: escapeRegex(query.search), $options: "i" };
    conditions.push({ $or: [{ title: contains }, { description: contains }] });
  }
  return conditions;
};

// The list carries the event name for the picker but not the rest of the snapshot.
const SUMMARY_FIELDS = "ownerUserId scope title description presentationLayout publishedAt publishedBy archived archivedAt createdAt updatedAt content.event.eventName";

export const mongoProposalTemplateRepository: ProposalTemplateRepository = {
  async list(organizationId, viewer, query) {
    const conditions = listConditions(viewer, query);
    const [items, total] = await Promise.all([
      ProposalTemplate.find({ organizationId, $and: conditions })
        .select(SUMMARY_FIELDS)
        .sort({ title: 1, _id: 1 })
        .collation(collation)
        .skip(query.offset)
        .limit(query.limit)
        .lean<TemplateDocument[]>(),
      ProposalTemplate.countDocuments({ organizationId, $and: conditions }),
    ]);
    return { items: items.map(toSummary), total };
  },

  async findById(organizationId, templateId) {
    const template = await ProposalTemplate.findOne({ _id: templateId, organizationId }).lean<TemplateDocument | null>();
    return template ? toRecord(template) : null;
  },

  async create(input) {
    const created = await ProposalTemplate.create({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      scope: input.scope,
      title: input.title,
      description: input.description,
      content: input.content,
      presentationLayout: input.presentationLayout,
      publishedAt: input.publishedAt,
      publishedBy: input.publishedBy,
    });
    return toRecord(created.toObject() as unknown as TemplateDocument);
  },

  async rename({ organizationId, templateId, changes }) {
    const template = await ProposalTemplate.findOneAndUpdate(
      { _id: templateId, organizationId, archived: false },
      { $set: changes },
      { new: true, runValidators: true },
    ).lean<TemplateDocument | null>();
    return template ? toRecord(template) : null;
  },

  // Matches the publisher's own personal template or an unpublished organization template, so a
  // personal template can never be published by anyone but its owner.
  async publish({ organizationId, templateId, publishedBy, at }) {
    const template = await ProposalTemplate.findOneAndUpdate(
      {
        _id: templateId,
        organizationId,
        archived: false,
        $or: [{ scope: "personal", ownerUserId: publishedBy }, { scope: "organization", publishedAt: null }],
      },
      { $set: { scope: "organization", publishedAt: at, publishedBy } },
      { new: true, runValidators: true },
    ).lean<TemplateDocument | null>();
    return template ? toRecord(template) : null;
  },

  async unpublish({ organizationId, templateId }) {
    const template = await ProposalTemplate.findOneAndUpdate(
      { _id: templateId, organizationId, scope: "organization", publishedAt: { $ne: null } },
      { $set: { publishedAt: null, publishedBy: null } },
      { new: true, runValidators: true },
    ).lean<TemplateDocument | null>();
    return template ? toRecord(template) : null;
  },

  // Archiving clears the publication; restoring leaves an organization template unpublished.
  async setArchived({ organizationId, templateId, archived, at }) {
    const template = await ProposalTemplate.findOneAndUpdate(
      { _id: templateId, organizationId, archived: !archived },
      { $set: archived ? { archived: true, archivedAt: at, publishedAt: null, publishedBy: null } : { archived: false, archivedAt: null } },
      { new: true, runValidators: true },
    ).lean<TemplateDocument | null>();
    return template ? toRecord(template) : null;
  },
};

export const isValidTemplateId = (value: string) => mongoose.isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value);
