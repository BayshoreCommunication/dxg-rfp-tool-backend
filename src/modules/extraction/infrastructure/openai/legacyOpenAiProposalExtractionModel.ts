import OpenAI from "openai";
import type { ProposalExtractionModel } from "../../domain/ports/proposalExtractionModel";

const cleanJson = (value: string) =>
  value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

export const legacyOpenAiProposalExtractionModel: ProposalExtractionModel = {
  async extract({ prompt, promptVersion, documentText }) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${prompt}\n\nPrompt version: ${promptVersion}` },
        { role: "user", content: `Document text:\n\n${documentText}` },
      ],
    });
    const content = cleanJson(completion.choices[0]?.message?.content ?? "");
    if (!content) return {};
    try {
      const parsed: unknown = JSON.parse(content);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  },
};
