import { createProposalTemplates } from "./application/manageProposalTemplates";
import { isValidTemplateId, mongoProposalTemplateRepository } from "./infrastructure/mongoProposalTemplateRepository";
import { mongoSecurityAuditWriter } from "../auth/infrastructure/audit/mongoSecurityAuditWriter";
import { createProposalFromTemplate, findProposalTemplateSource } from "../proposals/composition";

export const proposalTemplates = createProposalTemplates({
  templates: mongoProposalTemplateRepository,
  // Read and write go through the proposals module, so the RFP access policy decides which RFP
  // can be saved and the plan limit, team default and lifecycle apply to the RFP that is created.
  source: {
    findViewable: async ({ proposalId, userId }) =>
      (await findProposalTemplateSource({ proposalId, ownerUserId: userId })) as Record<string, unknown> | null,
  },
  proposals: { createFromTemplate: (input) => createProposalFromTemplate(input) },
  audit: mongoSecurityAuditWriter,
  isValidId: isValidTemplateId,
});
