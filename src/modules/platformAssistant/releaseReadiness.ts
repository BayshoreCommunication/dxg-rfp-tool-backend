export const ASSISTANT_PILOT_RELEASE_RECORD_VERSION =
  "assistant-pilot-release.v1";

export const ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY = [
  {
    service: "backend",
    name: "AI_ENVIRONMENT",
    classification: "configuration",
    requiredForPilot: true,
    safeOffValue: "production",
  },
  {
    service: "backend",
    name: "OPENAI_API_KEY",
    classification: "secret",
    requiredForPilot: true,
    safeOffValue: null,
  },
  {
    service: "backend",
    name: "AI_SAFETY_IDENTIFIER_SECRET",
    classification: "secret",
    requiredForPilot: true,
    safeOffValue: null,
  },
  {
    service: "backend",
    name: "AI_ANALYTICS_PSEUDONYM_KEY",
    classification: "secret",
    requiredForPilot: true,
    safeOffValue: null,
  },
  {
    service: "backend",
    name: "AI_ASSISTANT_ENABLED",
    classification: "feature_flag",
    requiredForPilot: true,
    safeOffValue: "false",
  },
  {
    service: "backend",
    name: "AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS",
    classification: "authorization_scope",
    requiredForPilot: true,
    safeOffValue: "",
  },
  {
    service: "backend",
    name: "AI_ASSISTANT_KILL_SWITCH",
    classification: "kill_switch",
    requiredForPilot: true,
    safeOffValue: "true",
  },
  {
    service: "backend",
    name: "AI_ASSISTANT_MODEL",
    classification: "release_decision",
    requiredForPilot: true,
    safeOffValue: "",
  },
  {
    service: "backend",
    name: "AI_ASSISTANT_ANALYTICS_ENABLED",
    classification: "feature_flag",
    requiredForPilot: true,
    safeOffValue: "false",
  },
  {
    service: "backend",
    name: "AI_RETENTION_PURGE_ENABLED",
    classification: "destructive_gate",
    requiredForPilot: false,
    safeOffValue: "false",
  },
  {
    service: "backend",
    name: "AI_RETENTION_POLICY_APPROVED",
    classification: "destructive_gate",
    requiredForPilot: false,
    safeOffValue: "false",
  },
  {
    service: "backend",
    name: "AI_RETENTION_PRODUCTION_EXECUTION_APPROVED",
    classification: "destructive_gate",
    requiredForPilot: false,
    safeOffValue: "false",
  },
  {
    service: "dashboard",
    name: "NEXT_PUBLIC_AI_ASSISTANT_ENABLED",
    classification: "feature_flag",
    requiredForPilot: true,
    safeOffValue: "false",
  },
] as const;

export type AssistantPilotReleaseRecord = {
  version: typeof ASSISTANT_PILOT_RELEASE_RECORD_VERSION;
  target: "staging_internal" | "production_limited";
  releaseOwner: string;
  productApprover: string;
  rollbackAuthority: string;
  supportOwner: string;
  application: {
    backendCommit: string;
    dashboardCommit: string;
    promptVersion: string;
    migrationsAppliedThrough: string;
  };
  model: {
    baseline: string;
    candidate: string;
    decision:
      | "baseline_approved"
      | "candidate_approved"
      | "candidate_rejected";
  };
  governedAssets: {
    knowledgeRelease: string;
    ruleRelease: string;
    priceRelease: string;
    verifiedForApplicationRelease: boolean;
  };
  organizationAllowlist: string[];
  monitoring: {
    startsAt: string;
    endsAt: string;
    onCallOwner: string;
    alertsConfigured: boolean;
  };
  privacy: {
    retentionPolicyApproved: boolean;
    providerTermsReviewed: boolean;
  };
  evidence: {
    backendCiPassed: boolean;
    dashboardCiPassed: boolean;
    evaluationPassed: boolean;
    migrationsVerified: boolean;
    smokeTestsPassed: boolean;
    killSwitchDrillPassed: boolean;
    rollbackReviewed: boolean;
    supportWorkflowReviewed: boolean;
  };
};

export type AssistantReleaseReadinessCheck = {
  id: string;
  passed: boolean;
  detail: string;
};

export type AssistantReleaseReadiness = {
  verdict: "GO" | "CONDITIONAL GO" | "NO-GO";
  checks: AssistantReleaseReadinessCheck[];
  blockers: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const sha = (value: string): boolean => /^[0-9a-f]{7,40}$/i.test(value);

const date = (value: string): number => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export const parseAssistantPilotReleaseRecord = (
  value: unknown,
): { record: AssistantPilotReleaseRecord | null; errors: string[] } => {
  if (!isRecord(value)) return { record: null, errors: ["record must be an object"] };
  const errors: string[] = [];
  if (value.version !== ASSISTANT_PILOT_RELEASE_RECORD_VERSION) {
    errors.push(
      `version must be ${ASSISTANT_PILOT_RELEASE_RECORD_VERSION}`,
    );
  }
  if (
    value.target !== "staging_internal" &&
    value.target !== "production_limited"
  ) {
    errors.push("target must be staging_internal or production_limited");
  }
  for (const field of [
    "releaseOwner",
    "productApprover",
    "rollbackAuthority",
    "supportOwner",
  ]) {
    if (typeof value[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (!isRecord(value.application)) errors.push("application must be an object");
  if (!isRecord(value.model)) errors.push("model must be an object");
  if (!isRecord(value.governedAssets)) {
    errors.push("governedAssets must be an object");
  }
  if (
    !Array.isArray(value.organizationAllowlist) ||
    !value.organizationAllowlist.every((item) => typeof item === "string")
  ) {
    errors.push("organizationAllowlist must be a string array");
  }
  if (!isRecord(value.monitoring)) errors.push("monitoring must be an object");
  if (!isRecord(value.privacy)) errors.push("privacy must be an object");
  if (!isRecord(value.evidence)) errors.push("evidence must be an object");
  if (errors.length > 0) return { record: null, errors };
  return { record: value as AssistantPilotReleaseRecord, errors: [] };
};

const check = (
  checks: AssistantReleaseReadinessCheck[],
  id: string,
  passed: boolean,
  detail: string,
): void => {
  checks.push({ id, passed, detail });
};

export const evaluateAssistantReleaseReadiness = (
  record: AssistantPilotReleaseRecord,
): AssistantReleaseReadiness => {
  const checks: AssistantReleaseReadinessCheck[] = [];
  check(
    checks,
    "named_owners",
    [
      record.releaseOwner,
      record.productApprover,
      record.rollbackAuthority,
      record.supportOwner,
    ].every(nonEmpty),
    "Release, Product, rollback, and support owners must be named.",
  );
  check(
    checks,
    "application_release",
    sha(record.application.backendCommit) &&
      sha(record.application.dashboardCommit) &&
      record.application.promptVersion === "platform-assistant-prompt.v5",
    "Backend/dashboard commits and the deployed prompt version must be exact.",
  );
  check(
    checks,
    "migrations",
    record.application.migrationsAppliedThrough === "036" &&
      record.evidence.migrationsVerified,
    "PostgreSQL migrations must be verified through 036.",
  );
  check(
    checks,
    "model_decision",
    [
      "baseline_approved",
      "candidate_approved",
      "candidate_rejected",
    ].includes(record.model.decision) &&
      nonEmpty(record.model.baseline) &&
      nonEmpty(record.model.candidate) &&
      record.evidence.evaluationPassed,
    "The model decision must be explicit and backed by the versioned evaluation.",
  );
  check(
    checks,
    "governed_assets",
    [
      record.governedAssets.knowledgeRelease,
      record.governedAssets.ruleRelease,
      record.governedAssets.priceRelease,
    ].every(nonEmpty) &&
      record.governedAssets.verifiedForApplicationRelease,
    "Knowledge, rule, and price releases must be approved and verified for this application release.",
  );
  check(
    checks,
    "organization_allowlist",
    record.organizationAllowlist.length > 0 &&
      record.organizationAllowlist.every((id) => /^[0-9a-f]{24}$/.test(id)),
    "The pilot requires exact 24-character organization IDs and never a wildcard.",
  );
  const startsAt = date(record.monitoring.startsAt);
  const endsAt = date(record.monitoring.endsAt);
  check(
    checks,
    "monitoring",
    Number.isFinite(startsAt) &&
      Number.isFinite(endsAt) &&
      endsAt > startsAt &&
      nonEmpty(record.monitoring.onCallOwner) &&
      record.monitoring.alertsConfigured,
    "A bounded monitoring window, named on-call owner, and alerts are required.",
  );
  check(
    checks,
    "privacy",
    record.privacy.retentionPolicyApproved &&
      record.privacy.providerTermsReviewed,
    "Retention policy and provider storage/processing terms require approval.",
  );
  check(
    checks,
    "quality_gates",
    record.evidence.backendCiPassed &&
      record.evidence.dashboardCiPassed &&
      record.evidence.smokeTestsPassed,
    "Backend CI, dashboard CI, and authenticated smoke tests must pass.",
  );
  check(
    checks,
    "operational_drills",
    record.evidence.killSwitchDrillPassed &&
      record.evidence.rollbackReviewed &&
      record.evidence.supportWorkflowReviewed,
    "Kill-switch, rollback, and support workflows must be verified.",
  );
  const blockers = checks
    .filter((item) => !item.passed)
    .map((item) => item.detail);
  return {
    verdict: blockers.length === 0 ? "GO" : "NO-GO",
    checks,
    blockers,
  };
};

export const safeOffEnvironmentIssues = (
  env: NodeJS.ProcessEnv,
): string[] =>
  ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY.flatMap((item) => {
    if (item.safeOffValue === null) return [];
    const actual = env[item.name] ?? "";
    return actual === item.safeOffValue
      ? []
      : [`${item.name} must be ${JSON.stringify(item.safeOffValue)} for flags-off deployment.`];
  });
