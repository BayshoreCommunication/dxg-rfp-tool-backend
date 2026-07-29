import {
  parseRetrievalInput,
  retrievalEnabled,
} from "../knowledgeRetrieval/domain";
import { knowledgeRetrievalRepository } from "../knowledgeRetrieval/postgresKnowledgeRetrievalRepository";
import {
  ASSISTANT_KNOWLEDGE_MAX_RESULTS,
  type AssistantPromptEvidence,
} from "./domain";
import type {
  AssistantKnowledgeResult,
  AssistantKnowledgeSource,
} from "./ports";

type RetrievalResult = {
  policyVersion: string;
  results: Array<{
    fragmentId: string;
    releaseId: string;
    sourceType: string;
    content: string;
  }>;
};

type RetrievalRepository = {
  retrieve(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    fixture: "free_text";
    query: string;
    filters: {
      sourceTypes: string[];
      market: string | null;
      currency: string | null;
    };
    limit: number;
    idempotencyKey: string;
    correlationId: string;
    purpose: "knowledge_retrieval";
  }): Promise<RetrievalResult>;
};

const unavailable = (diagnosticCode: string): AssistantKnowledgeResult => ({
  status: {
    state: "unavailable",
    safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE",
    diagnosticCode,
  },
  evidence: [],
});

const configuredLimit = (requested: number): number => {
  const configured = Number(process.env.AI_ASSISTANT_MAX_KNOWLEDGE_RESULTS);
  const maximum = Number.isInteger(configured)
    ? Math.min(Math.max(configured, 1), ASSISTANT_KNOWLEDGE_MAX_RESULTS)
    : ASSISTANT_KNOWLEDGE_MAX_RESULTS;
  return Math.min(Math.max(requested, 1), maximum);
};

export const createApprovedKnowledgeSource = (
  repository: RetrievalRepository,
  enabled: () => boolean = retrievalEnabled,
): AssistantKnowledgeSource => ({
  async retrieve(input): Promise<AssistantKnowledgeResult> {
    if (!enabled()) return unavailable("KNOWLEDGE_RETRIEVAL_DISABLED");

    try {
      const parsed = parseRetrievalInput({
        query: input.query,
        filters: {
          sourceTypes: ["operating_guidance"],
          market: null,
          currency: null,
        },
        limit: configuredLimit(input.limit),
      });
      if (parsed.fixture !== "free_text") {
        return unavailable("INVALID_ASSISTANT_RETRIEVAL_MODE");
      }
      const result = await repository.retrieve({
        ...input,
        fixture: "free_text",
        query: parsed.query,
        filters: parsed.filters,
        limit: parsed.limit,
        purpose: "knowledge_retrieval",
      });
      const evidence: AssistantPromptEvidence[] = result.results
        .filter((item) => item.sourceType === "operating_guidance")
        .map((item) => ({
          id: `knowledge:${item.releaseId}:${item.fragmentId}`,
          sourceType: "operating_guidance",
          trust: "untrusted_retrieved_content",
          title: "Approved operating guidance",
          content: item.content,
          releaseId: item.releaseId,
          fragmentId: item.fragmentId,
        }));
      return {
        status: {
          state: "available",
          policyVersion: result.policyVersion,
          resultCount: evidence.length,
        },
        evidence,
      };
    } catch (error) {
      const diagnosticCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "KNOWLEDGE_RETRIEVAL_FAILED")
          : "KNOWLEDGE_RETRIEVAL_FAILED";
      return unavailable(diagnosticCode);
    }
  },
});

export const approvedKnowledgeSource = createApprovedKnowledgeSource(
  knowledgeRetrievalRepository,
);
