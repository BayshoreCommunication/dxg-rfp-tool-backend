import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ProposalExtractionPatchV1 } from "../../generated/proposal-extraction-patch-v1";
import type { ProposalPublicV1 } from "../../generated/proposal-public-v1";
import type { ProposalV1 } from "../../generated/proposal-v1";
import extractionPatchSchema from "./proposal-extraction-patch.v1.schema.json";
import publicProposalSchema from "./proposal-public.v1.schema.json";
import proposalSchema from "./proposal.v1.schema.json";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});

addFormats(ajv);
ajv.addSchema(proposalSchema);

const proposalSchemaId = proposalSchema.$id;
const proposalValidator = ajv.getSchema<ProposalV1>(proposalSchemaId);

if (!proposalValidator) {
  throw new Error(`Unable to compile canonical proposal schema: ${proposalSchemaId}`);
}

export const validateProposalV1: ValidateFunction<ProposalV1> = proposalValidator;
export const validateProposalExtractionPatchV1 =
  ajv.compile<ProposalExtractionPatchV1>(extractionPatchSchema);
export const validateProposalPublicV1 =
  ajv.compile<ProposalPublicV1>(publicProposalSchema);

export type ContractValidationIssue = {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

export const formatContractErrors = (
  errors: ErrorObject[] | null | undefined,
): ContractValidationIssue[] =>
  (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "Contract validation failed",
    params: error.params,
  }));
