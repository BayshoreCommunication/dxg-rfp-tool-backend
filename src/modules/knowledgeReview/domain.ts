export type FragmentDecision = "accepted" | "rejected" | "flagged";
export class KnowledgeReviewError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export const independentApprovalRequired = () =>
  process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED === "true";
export const submissionDecision = (decision: FragmentDecision | null) =>
  decision ?? "accepted";
export const decisionInput = (value: Record<string, unknown>) => {
  const decision = String(value.decision || "") as FragmentDecision,
    reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!["accepted", "rejected", "flagged"].includes(decision))
    throw new KnowledgeReviewError(
      "INVALID_DECISION",
      "Decision must be accepted, rejected, or flagged.",
      422,
    );
  if (decision !== "accepted" && (reason.length < 3 || reason.length > 1000))
    throw new KnowledgeReviewError(
      "REVIEW_REASON_REQUIRED",
      "A reason between 3 and 1,000 characters is required.",
      422,
    );
  return { decision, reason: reason || null };
};
export const approvalInput = (
  value: Record<string, unknown>,
  decision: "approved" | "rejected",
) => {
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (decision === "rejected" && (reason.length < 3 || reason.length > 1000))
    throw new KnowledgeReviewError(
      "REJECTION_REASON_REQUIRED",
      "A rejection reason between 3 and 1,000 characters is required.",
      422,
    );
  return { reason: reason || null };
};
export const reviewDates = (value: Record<string, unknown>) => {
  const effectiveAt =
      typeof value.effectiveAt === "string" && value.effectiveAt
        ? new Date(value.effectiveAt)
        : null,
    expiresAt =
      typeof value.expiresAt === "string" && value.expiresAt
        ? new Date(value.expiresAt)
        : null;
  if (
    (effectiveAt && Number.isNaN(effectiveAt.valueOf())) ||
    (expiresAt && Number.isNaN(expiresAt.valueOf()))
  )
    throw new KnowledgeReviewError(
      "INVALID_REVIEW_DATES",
      "Effective and expiry dates must be valid.",
      422,
    );
  if (effectiveAt && expiresAt && expiresAt <= effectiveAt)
    throw new KnowledgeReviewError(
      "INVALID_REVIEW_DATES",
      "Expiry must be later than the effective date.",
      422,
    );
  return { effectiveAt, expiresAt };
};
