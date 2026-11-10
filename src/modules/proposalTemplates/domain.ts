import type { TemplateContent } from "../proposals/domain/templateSnapshot";

export class ProposalTemplateError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ProposalTemplateError";
  }
}

export type TemplateActor = { organizationId: string; userId: string; roles: readonly string[]; correlationId: string };

export const TEMPLATE_SCOPES = ["personal", "organization"] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];
export const PRESENTATION_LAYOUTS = ["template-one", "template-two"] as const;
export type PresentationLayout = (typeof PRESENTATION_LAYOUTS)[number];

export type ProposalTemplateRecord = {
  id: string;
  ownerUserId: string;
  scope: TemplateScope;
  title: string;
  description: string;
  content: TemplateContent;
  presentationLayout: PresentationLayout | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type ProposalTemplateSummaryRecord = Omit<ProposalTemplateRecord, "content"> & { eventName: string };

export type TemplateListScope = TemplateScope | "all";
export type TemplateListStatus = "active" | "archived" | "all";
export type TemplateListQuery = { scope: TemplateListScope; status: TemplateListStatus; search: string; limit: number; offset: number };
// Who is looking. The repository builds the visibility filter from this and nothing else:
// the viewer's own personal templates, published organization templates, and (for members who
// manage organization templates) unpublished and archived organization templates too.
export type TemplateViewer = { userId: string; managesOrganizationTemplates: boolean };

// Every method names the organization, so a foreign id is indistinguishable from a missing one.
export interface ProposalTemplateRepository {
  list(organizationId: string, viewer: TemplateViewer, query: TemplateListQuery): Promise<{ items: ProposalTemplateSummaryRecord[]; total: number }>;
  findById(organizationId: string, templateId: string): Promise<ProposalTemplateRecord | null>;
  create(input: {
    organizationId: string;
    ownerUserId: string;
    scope: TemplateScope;
    title: string;
    description: string;
    content: TemplateContent;
    presentationLayout: PresentationLayout | null;
    publishedAt: Date | null;
    publishedBy: string | null;
  }): Promise<ProposalTemplateRecord>;
  // Each write matches only the state it expects and returns null when the template is missing
  // or no longer in that state, so two requests can't both apply the same change.
  rename(input: { organizationId: string; templateId: string; changes: { title?: string; description?: string } }): Promise<ProposalTemplateRecord | null>;
  publish(input: { organizationId: string; templateId: string; publishedBy: string; at: Date }): Promise<ProposalTemplateRecord | null>;
  unpublish(input: { organizationId: string; templateId: string }): Promise<ProposalTemplateRecord | null>;
  setArchived(input: { organizationId: string; templateId: string; archived: boolean; at: Date }): Promise<ProposalTemplateRecord | null>;
}

// The RFP a template is saved from, read through the RFP access policy for the acting member
// (view access). Null when it is missing or in another organization; an RFP in the organization
// that the member can't see throws the policy's ProposalAccessDeniedError.
export interface TemplateSourceReader {
  findViewable(input: { proposalId: string; userId: string }): Promise<Record<string, unknown> | null>;
}

// Creates the RFP. The implementation is the proposals module's own create path, so the new RFP
// takes a plan slot (ORG-601), lands on the creator's team (ORG-202) and records its lifecycle.
export interface TemplateProposalCreator {
  createFromTemplate(input: {
    ownerUserId: string;
    content: TemplateContent;
    presentationLayout: PresentationLayout | null;
    overrides: { eventName?: string };
    fallbackEventName: string;
  }): Promise<object>;
}
