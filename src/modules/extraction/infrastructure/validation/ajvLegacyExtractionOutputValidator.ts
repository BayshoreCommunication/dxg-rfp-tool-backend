import Ajv2020 from "ajv/dist/2020";
import type { ExtractionOutputValidator } from "../../domain/ports/extractionPromptRegistry";
import schema from "./legacy-extraction-result.v1.schema.json";

const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export const ajvLegacyExtractionOutputValidator: ExtractionOutputValidator = {
  validate(value) {
    if (validator(value)) {
      return { valid: true, data: value as Record<string, unknown> };
    }
    return {
      valid: false,
      issues: (validator.errors ?? []).map(
        (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      ),
    };
  },
};
