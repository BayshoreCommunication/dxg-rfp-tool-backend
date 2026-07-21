import OpenAI from "openai";
import { aiRuntimeAuthorized } from "../../../config/aiEnvironment";
import { deterministicEmbedding } from "./deterministicEmbedding";
import { KnowledgeRetrievalError } from "./domain";

// Zero-padding preserves cosine similarity between vectors padded the same way,
// so the 16-dim mock release can share the provider-dimension storage column.
export const padToDimension = (vector: number[], dimension: number): number[] =>
  vector.length >= dimension ? vector.slice(0, dimension) : [...vector, ...Array(dimension - vector.length).fill(0)];

const BATCH_SIZE = 64;
const MAX_CHARS_PER_TEXT = 8000;

// The embedding release row (provider/model/dimension) is the governed source
// of selection; this function only executes what the registry approved.
export async function embedTexts(
  release: { provider: string; model: string; dimension: number },
  texts: string[],
): Promise<number[][]> {
  if (!texts.length) return [];
  if (release.provider === "mock")
    return texts.map((text) => padToDimension(deterministicEmbedding(text), release.dimension));
  if (release.provider !== "openai")
    throw new KnowledgeRetrievalError("EMBEDDING_PROVIDER_DENIED", "The configured embedding provider is not approved.", 503);
  if (!aiRuntimeAuthorized() || process.env.KNOWLEDGE_EMBEDDING_KILL_SWITCH === "true")
    throw new KnowledgeRetrievalError("EMBEDDING_PROVIDER_DISABLED", "Live embeddings are disabled in this environment.", 503);
  if (!process.env.OPENAI_API_KEY)
    throw new KnowledgeRetrievalError("EMBEDDING_CREDENTIAL_UNAVAILABLE", "The embedding provider credential is unavailable.", 503);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 0 });
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE).map((text) => text.slice(0, MAX_CHARS_PER_TEXT) || " ");
    let response;
    try {
      response = await client.embeddings.create({ model: release.model, input: batch, dimensions: release.dimension });
    } catch (error) {
      const status = Number((error as { status?: number }).status || 0);
      const retryable = status === 429 || status >= 500;
      throw new KnowledgeRetrievalError(
        retryable ? "EMBEDDING_PROVIDER_TEMPORARY" : "EMBEDDING_PROVIDER_FAILED",
        "The embedding provider request failed.",
        retryable ? 503 : 502,
      );
    }
    for (const item of [...response.data].sort((a, b) => a.index - b.index)) {
      if (item.embedding.length !== release.dimension)
        throw new KnowledgeRetrievalError("EMBEDDING_DIMENSION_MISMATCH", "The embedding provider returned an unexpected dimension.", 502);
      vectors.push(item.embedding);
    }
  }
  if (vectors.length !== texts.length)
    throw new KnowledgeRetrievalError("EMBEDDING_PROVIDER_FAILED", "The embedding provider returned an incomplete batch.", 502);
  return vectors;
}
