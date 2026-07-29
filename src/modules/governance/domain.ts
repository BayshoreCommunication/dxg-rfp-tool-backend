export const GOVERNED_ASSET_TYPES = [
  "knowledge_release",
  "expert_rule",
  "pricing_record",
  "pricing_regional_factor",
  "pricing_modifier",
  "pricing_confidence_rule",
] as const;
export const GOVERNED_APPROVAL_STATES = [
  "draft",
  "approved",
  "revoked",
] as const;
export const GOVERNED_LIFECYCLE_STATES = [
  "active",
  "retired",
] as const;

export type GovernedAssetType = (typeof GOVERNED_ASSET_TYPES)[number];
export type GovernedApprovalState =
  (typeof GOVERNED_APPROVAL_STATES)[number];
export type GovernedLifecycleState =
  (typeof GOVERNED_LIFECYCLE_STATES)[number];

export class GovernanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      "A JSON object is required.",
    );
  }
  return value as Record<string, unknown>;
};
const text = (
  value: unknown,
  name: string,
  pattern: RegExp,
  optional = false,
): string | null => {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} is required.`,
    );
  }
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} is invalid.`,
    );
  }
  return value.trim();
};
const instant = (
  value: unknown,
  name: string,
  optional = false,
): string | null => {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} is required.`,
    );
  }
  if (typeof value !== "string") {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} must be an ISO timestamp.`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} must be an ISO timestamp.`,
    );
  }
  return parsed.toISOString();
};
const positiveInteger = (value: unknown, name: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      `${name} must be a positive integer.`,
    );
  }
  return parsed;
};
const uuid = (value: unknown, name: string) =>
  text(
    value,
    name,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )!.toLowerCase();

export type GovernedAssetListFilters = {
  assetType: GovernedAssetType | null;
  approvalState: GovernedApprovalState | null;
  lifecycleState: GovernedLifecycleState | null;
  dueWithinDays: number | null;
  limit: number;
  offset: number;
};

export const parseGovernedAssetListFilters = (
  query: Record<string, unknown>,
): GovernedAssetListFilters => {
  const member = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    name: string,
  ): T | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new GovernanceError(
        "INVALID_GOVERNANCE_FILTER",
        `${name} is invalid.`,
      );
    }
    return value as T;
  };
  const due =
    query.dueWithinDays === undefined || query.dueWithinDays === ""
      ? null
      : Number(query.dueWithinDays);
  if (
    due !== null &&
    (!Number.isInteger(due) || due < 0 || due > 365)
  ) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_FILTER",
      "dueWithinDays must be between 0 and 365.",
    );
  }
  return {
    assetType: member(
      query.assetType,
      GOVERNED_ASSET_TYPES,
      "assetType",
    ),
    approvalState: member(
      query.approvalState,
      GOVERNED_APPROVAL_STATES,
      "approvalState",
    ),
    lifecycleState: member(
      query.lifecycleState,
      GOVERNED_LIFECYCLE_STATES,
      "lifecycleState",
    ),
    dueWithinDays: due,
    limit: Math.min(Math.max(Number(query.limit) || 25, 1), 50),
    offset: Math.min(Math.max(Number(query.offset) || 0, 0), 5_000),
  };
};

export type GovernedAssetUpdate = {
  expectedRevision: number;
  ownerExternalUserId?: string;
  productArea?: string;
  locale?: string;
  sourceReference?: string;
  effectiveAt?: string;
  reviewDueAt?: string;
  expiresAt?: string | null;
  approvalState?: GovernedApprovalState;
  lifecycleState?: GovernedLifecycleState;
  lastVerifiedApplicationRelease?: string;
};

export const parseGovernedAssetUpdate = (
  value: unknown,
): GovernedAssetUpdate => {
  const input = object(value);
  const update: GovernedAssetUpdate = {
    expectedRevision: positiveInteger(
      input.expectedRevision,
      "expectedRevision",
    ),
  };
  if (input.ownerExternalUserId !== undefined) {
    update.ownerExternalUserId = text(
      input.ownerExternalUserId,
      "ownerExternalUserId",
      /^[0-9a-f]{24}$/i,
    )!.toLowerCase();
  }
  if (input.productArea !== undefined) {
    update.productArea = text(
      input.productArea,
      "productArea",
      /^[a-z0-9_-]{2,60}$/,
    )!;
  }
  if (input.locale !== undefined) {
    update.locale = text(
      input.locale,
      "locale",
      /^[a-z]{2,3}(-[A-Z]{2})?$/,
    )!;
  }
  if (input.sourceReference !== undefined) {
    update.sourceReference = text(
      input.sourceReference,
      "sourceReference",
      /^.{1,300}$/s,
    )!;
  }
  if (input.effectiveAt !== undefined) {
    update.effectiveAt = instant(input.effectiveAt, "effectiveAt")!;
  }
  if (input.reviewDueAt !== undefined) {
    update.reviewDueAt = instant(input.reviewDueAt, "reviewDueAt")!;
  }
  if (input.expiresAt !== undefined) {
    update.expiresAt = instant(input.expiresAt, "expiresAt", true);
  }
  if (input.approvalState !== undefined) {
    update.approvalState = text(
      input.approvalState,
      "approvalState",
      /^(draft|approved|revoked)$/,
    ) as GovernedApprovalState;
  }
  if (input.lifecycleState !== undefined) {
    update.lifecycleState = text(
      input.lifecycleState,
      "lifecycleState",
      /^(active|retired)$/,
    ) as GovernedLifecycleState;
  }
  if (input.lastVerifiedApplicationRelease !== undefined) {
    update.lastVerifiedApplicationRelease = text(
      input.lastVerifiedApplicationRelease,
      "lastVerifiedApplicationRelease",
      /^[a-zA-Z0-9._:-]{1,100}$/,
    )!;
  }
  if (Object.keys(update).length === 1) {
    throw new GovernanceError(
      "INVALID_GOVERNANCE_INPUT",
      "At least one governance field must change.",
    );
  }
  return update;
};

export const parseReplacementActivation = (value: unknown) => {
  const input = object(value);
  return {
    replacementGovernedAssetId: uuid(
      input.replacementGovernedAssetId,
      "replacementGovernedAssetId",
    ),
    expectedRevision: positiveInteger(
      input.expectedRevision,
      "expectedRevision",
    ),
    replacementExpectedRevision: positiveInteger(
      input.replacementExpectedRevision,
      "replacementExpectedRevision",
    ),
  };
};

export const parseGovernedAssetId = (value: unknown) =>
  uuid(value, "governedAssetId");
