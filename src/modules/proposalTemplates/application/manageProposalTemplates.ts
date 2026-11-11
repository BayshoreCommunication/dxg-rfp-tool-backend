import { hasOrganizationAction } from "../../identity/domain/authorizationPolicy";
import type { SecurityAuditWriter } from "../../auth/domain/ports/sessionPorts";
import {
  PRESENTATION_LAYOUTS,
  ProposalTemplateError,
  TEMPLATE_SCOPES,
  type PresentationLayout,
  type ProposalTemplateRecord,
  type ProposalTemplateRepository,
  type ProposalTemplateSummaryRecord,
  type TemplateActor,
  type TemplateListQuery,
  type TemplateListScope,
  type TemplateListStatus,
  type TemplateProposalCreator,
  type TemplateScope,
  type TemplateSourceReader,
} from "../domain";
import { MAX_TEMPLATE_CONTENT_BYTES, templateContentBytes, templateContentOf } from "../../proposals/domain/templateSnapshot";

type Dependencies = {
  templates: ProposalTemplateRepository;
  source: TemplateSourceReader;
  proposals: TemplateProposalCreator;
  audit: SecurityAuditWriter;
  isValidId(value: string): boolean;
  now?: () => Date;
};

export const MAX_TEMPLATE_TITLE_LENGTH = 120;
export const MAX_TEMPLATE_DESCRIPTION_LENGTH = 500;
const MAX_EVENT_NAME_LENGTH = 200;
const MAX_SEARCH_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const LIST_SCOPES: readonly TemplateListScope[] = [...TEMPLATE_SCOPES, "all"];
const LIST_STATUSES: readonly TemplateListStatus[] = ["active", "archived", "all"];

const invalid = (code: string, message: string) => new ProposalTemplateError(code, message, 400);
const notFound = () => new ProposalTemplateError("TEMPLATE_NOT_FOUND", "Template not found.", 404);
const accessDenied = () => new ProposalTemplateError("TEMPLATE_ACCESS_DENIED", "You don't have access to this template.", 403);
const useDenied = () => new ProposalTemplateError("TEMPLATE_USE_DENIED", "Your role can't use RFP templates.", 403);
const publishDenied = () => new ProposalTemplateError("TEMPLATE_PUBLISH_DENIED", "Only Owners and Admins can manage organization templates.", 403);
const archivedError = (message: string) => new ProposalTemplateError("TEMPLATE_ARCHIVED", message, 409);
const sourceNotFound = () => new ProposalTemplateError("TEMPLATE_SOURCE_NOT_FOUND", "RFP not found.", 404);

const text = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

const titleOf = (value: unknown): string => {
  const title = text(value);
  if (!title || title.length > MAX_TEMPLATE_TITLE_LENGTH) {
    throw invalid("INVALID_TEMPLATE_TITLE", `Template title must be 1 to ${MAX_TEMPLATE_TITLE_LENGTH} characters.`);
  }
  return title;
};

const descriptionOf = (value: unknown): string => {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw invalid("INVALID_TEMPLATE_DESCRIPTION", "Description must be text.");
  }
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length > MAX_TEMPLATE_DESCRIPTION_LENGTH) {
    throw invalid("INVALID_TEMPLATE_DESCRIPTION", `Description must be at most ${MAX_TEMPLATE_DESCRIPTION_LENGTH} characters.`);
  }
  return description;
};

const scopeOf = (value: unknown): TemplateScope => {
  if (value === undefined) return "personal";
  if (typeof value !== "string" || !TEMPLATE_SCOPES.includes(value as TemplateScope)) {
    throw invalid("INVALID_TEMPLATE_SCOPE", "Scope must be personal or organization.");
  }
  return value as TemplateScope;
};

const layoutOf = (value: unknown): PresentationLayout | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PRESENTATION_LAYOUTS.includes(value as PresentationLayout)) {
    throw invalid("INVALID_TEMPLATE_LAYOUT", "Presentation layout must be template-one or template-two.");
  }
  return value as PresentationLayout;
};

const wholeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

// A repeated or nested parameter is refused, not read as the default.
const choice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T, code: string, message: string): T => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalid(code, message);
  return value as T;
};

const queryOf = (input: Record<string, unknown>): TemplateListQuery => ({
  scope: choice(input.scope, LIST_SCOPES, "all", "INVALID_TEMPLATE_SCOPE", "Scope must be personal, organization or all."),
  status: choice(input.status, LIST_STATUSES, "active", "INVALID_TEMPLATE_STATUS", "Status must be active, archived or all."),
  search: text(input.search).slice(0, MAX_SEARCH_LENGTH),
  limit: wholeNumber(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
  offset: wholeNumber(input.offset, 0, 0, Number.MAX_SAFE_INTEGER),
});

const eventNameOf = (content: unknown): string => {
  const event = (content as { event?: { eventName?: unknown } } | null)?.event;
  return typeof event?.eventName === "string" ? event.eventName : "";
};

export type ProposalTemplateSummary = ProposalTemplateSummaryRecord & {
  published: boolean;
  ownedByMe: boolean;
  // Whether this member can start an RFP from it right now.
  usable: boolean;
};
export type ProposalTemplateDetail = ProposalTemplateSummary & { content: ProposalTemplateRecord["content"] };

export const createProposalTemplates = (dependencies: Dependencies) => {
  const { templates, audit } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  /* Role rules live in authorizationPolicy (DXG decision Q4, follow-up F6): every member who can
     create RFPs uses templates and keeps personal ones; Owners and Admins manage organization
     templates; Viewers get neither. */
  const canUse = (actor: TemplateActor) => hasOrganizationAction(actor.roles, "template:use");
  const canManage = (actor: TemplateActor) => hasOrganizationAction(actor.roles, "template:publish");
  const requireUser = (actor: TemplateActor) => {
    if (!canUse(actor)) throw useDenied();
  };
  const requireManager = (actor: TemplateActor) => {
    requireUser(actor);
    if (!canManage(actor)) throw publishDenied();
  };

  const isOwner = (actor: TemplateActor, template: { ownerUserId: string }) => template.ownerUserId === actor.userId;
  // A personal template is its owner's alone, whatever the other member's role. An organization
  // template is everyone's once published; unpublished or archived it is seen by its managers.
  const canSee = (actor: TemplateActor, template: Pick<ProposalTemplateRecord, "scope" | "ownerUserId" | "publishedAt" | "archived">) =>
    template.scope === "personal"
      ? isOwner(actor, template)
      : canManage(actor) || (template.publishedAt !== null && !template.archived);
  const canChange = (actor: TemplateActor, template: Pick<ProposalTemplateRecord, "scope" | "ownerUserId">) =>
    template.scope === "personal" ? isOwner(actor, template) : canManage(actor);

  const summaryOf = (actor: TemplateActor, template: ProposalTemplateSummaryRecord): ProposalTemplateSummary => ({
    ...template,
    published: template.scope === "organization" && template.publishedAt !== null,
    ownedByMe: isOwner(actor, template),
    usable: !template.archived && (template.scope === "personal" || template.publishedAt !== null),
  });
  const detailOf = (actor: TemplateActor, template: ProposalTemplateRecord): ProposalTemplateDetail => {
    const { content, ...rest } = template;
    return { ...summaryOf(actor, { ...rest, eventName: eventNameOf(content) }), content };
  };

  // Titles are the template's label, not RFP content, so the audit trail may carry them.
  const record = (actor: TemplateActor, action: string, template: ProposalTemplateRecord, decision: "created" | "revoked" | "allowed", metadata: Record<string, unknown> = {}) =>
    audit.append({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      targetType: "proposal_template",
      targetId: template.id,
      decision,
      reason: action,
      correlationId: actor.correlationId,
      metadata: { title: template.title, scope: template.scope, ...metadata },
    });

  // A template of another organization is missing (404). One in this organization that the
  // member may not see is refused (403), the same convention as RFPs (ProposalAccessDeniedError).
  const load = async (actor: TemplateActor, templateId: string): Promise<ProposalTemplateRecord> => {
    const template = dependencies.isValidId(templateId) ? await templates.findById(actor.organizationId, templateId) : null;
    if (!template) throw notFound();
    if (!canSee(actor, template)) throw accessDenied();
    return template;
  };
  const loadToChange = async (actor: TemplateActor, templateId: string): Promise<ProposalTemplateRecord> => {
    const template = await load(actor, templateId);
    if (!canChange(actor, template)) throw publishDenied();
    return template;
  };

  return {
    async list(actor: TemplateActor, input: Record<string, unknown> = {}) {
      requireUser(actor);
      const query = queryOf(input);
      const { items, total } = await templates.list(
        actor.organizationId,
        { userId: actor.userId, managesOrganizationTemplates: canManage(actor) },
        query,
      );
      return { items: items.map((item) => summaryOf(actor, item)), total, limit: query.limit, offset: query.offset };
    },

    async get(actor: TemplateActor, templateId: string): Promise<ProposalTemplateDetail> {
      requireUser(actor);
      return detailOf(actor, await load(actor, templateId));
    },

    // Save an RFP as a template. The member needs view access to the RFP; saving straight to the
    // organization also needs the manage right and publishes the template at once.
    async saveFromProposal(actor: TemplateActor, input: Record<string, unknown>): Promise<ProposalTemplateDetail> {
      requireUser(actor);
      const scope = scopeOf(input.scope);
      if (scope === "organization" && !canManage(actor)) throw publishDenied();
      const title = titleOf(input.title);
      const description = descriptionOf(input.description);
      const presentationLayout = layoutOf(input.presentationLayout);
      const proposalId = typeof input.proposalId === "string" ? input.proposalId : "";
      if (!dependencies.isValidId(proposalId)) throw invalid("INVALID_TEMPLATE_SOURCE", "Choose the RFP to save as a template.");

      const proposal = await dependencies.source.findViewable({ proposalId, userId: actor.userId });
      if (!proposal) throw sourceNotFound();
      const content = templateContentOf(proposal);
      if (templateContentBytes(content) > MAX_TEMPLATE_CONTENT_BYTES) {
        throw new ProposalTemplateError("TEMPLATE_TOO_LARGE", "This RFP is too large to save as a template.", 413);
      }
      const at = now();
      const created = await templates.create({
        organizationId: actor.organizationId,
        ownerUserId: actor.userId,
        scope,
        title,
        description,
        content,
        presentationLayout,
        publishedAt: scope === "organization" ? at : null,
        publishedBy: scope === "organization" ? actor.userId : null,
      });
      await record(actor, "proposal_template.created", created, "created", { sourceProposalId: proposalId });
      if (scope === "organization") await record(actor, "proposal_template.published", created, "allowed", { previousScope: null });
      return detailOf(actor, created);
    },

    // Title and description only; the snapshot itself never changes after it is saved.
    async update(actor: TemplateActor, templateId: string, input: Record<string, unknown>): Promise<ProposalTemplateDetail> {
      requireUser(actor);
      const previous = await loadToChange(actor, templateId);
      if (previous.archived) throw archivedError("Restore this template before editing it.");
      const changes: { title?: string; description?: string } = {};
      if (input.title !== undefined) {
        const title = titleOf(input.title);
        if (title !== previous.title) changes.title = title;
      }
      if (input.description !== undefined) {
        const description = descriptionOf(input.description);
        if (description !== previous.description) changes.description = description;
      }
      const changed = Object.keys(changes);
      if (changed.length === 0) return detailOf(actor, previous);
      const updated = await templates.rename({ organizationId: actor.organizationId, templateId, changes });
      if (!updated) {
        // Archived by someone else since it was loaded (the write only matches active templates).
        await load(actor, templateId);
        throw archivedError("Restore this template before editing it.");
      }
      await record(actor, "proposal_template.updated", updated, "allowed", {
        changed,
        ...(changes.title ? { previousTitle: previous.title } : {}),
      });
      return detailOf(actor, updated);
    },

    // Makes a template available to every member who can create RFPs. The target is one of the
    // manager's own personal templates (it becomes an organization template) or an unpublished
    // organization template. Another member's personal template can't be published: only its
    // owner sees it.
    async publish(actor: TemplateActor, templateId: string): Promise<ProposalTemplateDetail> {
      requireManager(actor);
      const previous = await load(actor, templateId);
      if (previous.archived) throw archivedError("Restore this template before publishing it.");
      if (previous.scope === "organization" && previous.publishedAt !== null) return detailOf(actor, previous);
      const published = await templates.publish({ organizationId: actor.organizationId, templateId, publishedBy: actor.userId, at: now() });
      // Published or archived by a concurrent request: answer with the stored state.
      if (!published) {
        const current = await load(actor, templateId);
        if (current.archived) throw archivedError("Restore this template before publishing it.");
        return detailOf(actor, current);
      }
      await record(actor, "proposal_template.published", published, "allowed", { previousScope: previous.scope });
      return detailOf(actor, published);
    },

    // Takes an organization template out of the picker. It stays an organization template that
    // Owners and Admins can publish again; it does not return to anyone's personal list.
    async unpublish(actor: TemplateActor, templateId: string): Promise<ProposalTemplateDetail> {
      requireManager(actor);
      const previous = await load(actor, templateId);
      if (previous.scope !== "organization" || previous.publishedAt === null) return detailOf(actor, previous);
      const unpublished = await templates.unpublish({ organizationId: actor.organizationId, templateId });
      if (!unpublished) return detailOf(actor, await load(actor, templateId));
      await record(actor, "proposal_template.unpublished", unpublished, "revoked");
      return detailOf(actor, unpublished);
    },

    // Archiving also unpublishes, so a restored organization template has to be published again
    // on purpose. Owners of personal templates archive their own.
    async archive(actor: TemplateActor, templateId: string): Promise<ProposalTemplateDetail> {
      requireUser(actor);
      const previous = await loadToChange(actor, templateId);
      if (previous.archived) return detailOf(actor, previous);
      const archived = await templates.setArchived({ organizationId: actor.organizationId, templateId, archived: true, at: now() });
      if (!archived) return detailOf(actor, await load(actor, templateId));
      await record(actor, "proposal_template.archived", archived, "revoked", { wasPublished: previous.publishedAt !== null });
      return detailOf(actor, archived);
    },

    async restore(actor: TemplateActor, templateId: string): Promise<ProposalTemplateDetail> {
      requireUser(actor);
      const previous = await loadToChange(actor, templateId);
      if (!previous.archived) return detailOf(actor, previous);
      const restored = await templates.setArchived({ organizationId: actor.organizationId, templateId, archived: false, at: now() });
      if (!restored) return detailOf(actor, await load(actor, templateId));
      await record(actor, "proposal_template.restored", restored, "allowed");
      return detailOf(actor, restored);
    },

    /* Start a new RFP from a template. The RFP is an ordinary draft owned by the member who
       creates it; the proposals module's create path gives it a plan slot (PlanLimitReachedError
       at the limit, ORG-601) and the creator's team (ORG-202). The RFP record has no field for
       the presentation layout (the client keeps it while the RFP is written), so the template's
       layout is returned beside the RFP for the client to apply. */
    async createProposal(
      actor: TemplateActor,
      templateId: string,
      input: Record<string, unknown> = {},
    ): Promise<{ proposal: object; presentationLayout: PresentationLayout | null }> {
      requireUser(actor);
      const template = await load(actor, templateId);
      if (template.archived) throw archivedError("This template is archived and can't be used.");
      if (template.scope === "organization" && template.publishedAt === null) {
        throw new ProposalTemplateError("TEMPLATE_NOT_PUBLISHED", "Publish this template before using it.", 409);
      }
      if (input.eventName !== undefined && typeof input.eventName !== "string") {
        throw invalid("INVALID_TEMPLATE_EVENT_NAME", "Event name must be text.");
      }
      const eventName = text(input.eventName);
      if (eventName.length > MAX_EVENT_NAME_LENGTH) {
        throw invalid("INVALID_TEMPLATE_EVENT_NAME", `Event name must be at most ${MAX_EVENT_NAME_LENGTH} characters.`);
      }
      const proposal = await dependencies.proposals.createFromTemplate({
        ownerUserId: actor.userId,
        // Scrubbed again, so rules added after the template was saved still apply.
        content: templateContentOf(template.content),
        overrides: eventName ? { eventName } : {},
        fallbackEventName: template.title,
      });
      return { proposal, presentationLayout: template.presentationLayout };
    },
  };
};

export type ProposalTemplates = ReturnType<typeof createProposalTemplates>;
