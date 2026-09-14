import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { VendorResponseCalculationV1 } from "../../generated/vendor-response-calculation-v1";
import type { VendorResponseQuestionnaireV1 } from "../../generated/vendor-response-questionnaire-v1";
import type { VendorResponseValidationEnvelopeV1 } from "../../generated/vendor-response-validation-error-v1";
import type { VendorResponseV1 } from "../../generated/vendor-response-v1";
import type { VendorResponseWorkspaceV1 } from "../../generated/vendor-response-workspace-v1";
import calculationSchema from "./vendor-response-calculation.v1.schema.json";
import questionnaireSchema from "./vendor-response-questionnaire.v1.schema.json";
import validationEnvelopeSchema from "./vendor-response-validation-error.v1.schema.json";
import responseSchema from "./vendor-response.v1.schema.json";
import workspaceSchema from "./vendor-response-workspace.v1.schema.json";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});

addFormats(ajv);
ajv.addSchema(questionnaireSchema);
ajv.addSchema(responseSchema);
ajv.addSchema(calculationSchema);
ajv.addSchema(validationEnvelopeSchema);
ajv.addSchema(workspaceSchema);

const requireValidator = <T>(schemaId: string): ValidateFunction<T> => {
  const validator = ajv.getSchema<T>(schemaId);
  if (!validator) {
    throw new Error(`Unable to compile vendor response schema: ${schemaId}`);
  }
  return validator;
};

export const validateVendorResponseQuestionnaireV1 =
  requireValidator<VendorResponseQuestionnaireV1>(questionnaireSchema.$id);
export const validateVendorResponseV1 = requireValidator<VendorResponseV1>(responseSchema.$id);
export const validateVendorResponseCalculationV1 =
  requireValidator<VendorResponseCalculationV1>(calculationSchema.$id);
export const validateVendorResponseValidationEnvelopeV1 =
  requireValidator<VendorResponseValidationEnvelopeV1>(validationEnvelopeSchema.$id);
export const validateVendorResponseWorkspaceV1 =
  requireValidator<VendorResponseWorkspaceV1>(workspaceSchema.$id);

export type VendorResponseContractIssue = {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

export const formatVendorResponseContractErrors = (
  errors: ErrorObject[] | null | undefined,
): VendorResponseContractIssue[] =>
  (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "Contract validation failed",
    params: error.params,
  }));
