export interface ProposalExtractionModel {
  extract(input: {
    prompt: string;
    promptVersion: string;
    documentText: string;
  }): Promise<Record<string, unknown>>;
}
