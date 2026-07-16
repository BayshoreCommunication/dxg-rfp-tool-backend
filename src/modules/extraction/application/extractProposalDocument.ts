import type { DocumentTextExtractor } from "../domain/ports/documentTextExtractor";
import type { ProposalExtractionModel } from "../domain/ports/proposalExtractionModel";
import type {
  ExtractionOutputValidator,
  ExtractionPromptRegistry,
} from "../domain/ports/extractionPromptRegistry";

const TEXT_LIMIT = 40_000;

export const createExtractProposalDocument = (dependencies: {
  textExtractor: DocumentTextExtractor;
  model: ProposalExtractionModel;
  prompts: ExtractionPromptRegistry;
  outputValidator: ExtractionOutputValidator;
}) => async (input: {
  buffer: Buffer;
  mimetype: string;
}) => {
  const documentText = (
    await dependencies.textExtractor.extract({
      buffer: input.buffer,
      mimetype: input.mimetype,
    })
  ).trim();
  if (!documentText) {
    return {
      kind: "empty_document" as const,
      message:
        input.mimetype === "application/pdf"
          ? "PDF appears to have no extractable text. Try a text-based PDF or DOCX."
          : "Document appears empty.",
    };
  }
  const prompt = dependencies.prompts.current();
  const output = await dependencies.model.extract({
    prompt: prompt.content,
    promptVersion: prompt.id,
    documentText: documentText.slice(0, TEXT_LIMIT),
  });
  const validation = dependencies.outputValidator.validate(output);
  if (!validation.valid) {
    return {
      kind: "invalid_output" as const,
      promptVersion: prompt.id,
      schemaId: prompt.outputSchemaId,
      issues: validation.issues,
    };
  }
  return {
    kind: "extracted" as const,
    data: validation.data,
    promptVersion: prompt.id,
    schemaId: prompt.outputSchemaId,
  };
};
