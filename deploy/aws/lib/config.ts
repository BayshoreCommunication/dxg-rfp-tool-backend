/* Per-environment sizing and settings.
 *
 * Values that cannot be derived from the repository (account, domain,
 * certificate, alert email) are supplied via CDK context at synth time and
 * intentionally have no defaults — see README.md. Nothing here is a secret.
 */

export interface EnvironmentConfig {
  /** "staging" | "production" — used in stack and resource names. */
  readonly envName: string;
  /** Git branch whose pushes may deploy this environment via OIDC. */
  readonly deployBranch: string;
  readonly vpcCidr: string;
  readonly natGateways: number;
  readonly rds: {
    readonly instanceClass: string; // e.g. "t4g.small"
    readonly multiAz: boolean;
    readonly allocatedStorageGb: number;
    readonly backupRetentionDays: number;
    readonly deletionProtection: boolean;
  };
  readonly redis: {
    readonly nodeType: string; // e.g. "cache.t4g.micro"
    readonly replicas: number;
  };
  readonly ecs: {
    readonly api: TaskSize;
    readonly worker: TaskSize;
    readonly dispatcher: TaskSize;
    readonly clamav: TaskSize;
    readonly workerMaxCount: number;
  };
  /** ALB idle timeout. The assistant SSE stream can be silent for up to
   *  120s before its first token; WebSocket clients get no server pings. */
  readonly albIdleTimeoutSeconds: number;
  /** MongoDB database name inside the env's Atlas cluster (MONGODB_DB_NAME). */
  readonly mongoDbName: string;
  /** Governed AI surface (deny-by-default). Empty = every AI flag absent,
   *  the platform's safe state. Populating this IS the AI release for the
   *  env (docs/runbooks/PRODUCTION.md). */
  readonly aiEnvironment: Record<string, string>;
}

export interface TaskSize {
  readonly cpu: number; // Fargate CPU units (1024 = 1 vCPU)
  readonly memoryMiB: number;
}

export const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  staging: {
    envName: "staging",
    deployBranch: "main",
    vpcCidr: "10.40.0.0/16",
    natGateways: 1,
    rds: {
      instanceClass: "t4g.small",
      multiAz: false,
      allocatedStorageGb: 20,
      backupRetentionDays: 7,
      deletionProtection: false,
    },
    redis: { nodeType: "cache.t4g.micro", replicas: 0 },
    ecs: {
      api: { cpu: 512, memoryMiB: 1024 },
      worker: { cpu: 1024, memoryMiB: 2048 },
      dispatcher: { cpu: 256, memoryMiB: 512 },
      // clamd loads the full signature database into memory (~1.5–2.5 GiB).
      clamav: { cpu: 1024, memoryMiB: 3072 },
      workerMaxCount: 2,
    },
    albIdleTimeoutSeconds: 180,
    mongoDbName: "dxg_rfp_tool_staging",
    // Staging AI release 2026-08-02 (rev 2): full parity with local dev -
    // every AI surface on. Deterministic/mock providers for extraction and
    // knowledge embeddings (as in local dev); live OpenAI for conversation
    // replies (failures degrade to deterministic acknowledgments).
    // Retention purge stays off. Model pin per PRODUCTION.md.
    aiEnvironment: {
      AI_ENVIRONMENT: "staging",
      CONVERSATIONS_ENABLED: "true",
      PROPOSAL_CONTEXT_ENABLED: "true",
      PROPOSAL_CONTEXT_PROVIDER: "mock",
      PROPOSAL_CONTEXT_MODEL: "deterministic-v1",
      PROPOSAL_DRAFT_ENABLED: "true",
      PROPOSAL_WORKFLOW_ENABLED: "true",
      CANDIDATE_APPLICATION_ENABLED: "true",
      AI_ASSISTANT_ENABLED: "true",
      AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
      AI_ASSISTANT_KILL_SWITCH: "false",
      AI_GATEWAY_ENABLED: "true",
      GUIDANCE_ENABLED: "true",
      INVESTMENT_GUIDANCE_ENABLED: "true",
      PRICING_CORPUS_ENABLED: "true",
      VENDOR_ANALYSIS_ENABLED: "true",
      KNOWLEDGE_INGESTION_ENABLED: "true",
      KNOWLEDGE_RETRIEVAL_ENABLED: "true",
      KNOWLEDGE_REVIEW_ENABLED: "true",
      KNOWLEDGE_IN_DRAFT_ENABLED: "true",
      KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED: "false",
      KNOWLEDGE_EMBEDDING_PROVIDER: "mock",
      KNOWLEDGE_EMBEDDING_MODEL: "deterministic-v1",
      KNOWLEDGE_RETRIEVAL_MODE: "hybrid",
      KNOWLEDGE_RETRIEVAL_MAX_RESULTS: "20",
      KNOWLEDGE_RETRIEVAL_QUERY_TIMEOUT_MS: "500",
      LIVE_AI_PILOT_ENABLED: "true",
      LIVE_AI_PROVIDER: "openai",
      LIVE_AI_MODEL: "gpt-5.4-mini-2026-03-17",
      LIVE_AI_KILL_SWITCH: "false",
      LIVE_AI_INPUT_TOKEN_LIMIT: "32000",
      LIVE_AI_OUTPUT_TOKEN_LIMIT: "4000",
      LIVE_AI_NON_CONFIDENTIAL_ENABLED: "true",
      LIVE_AI_SYNTHETIC_ENABLED: "true",
      LIVE_AI_PROPOSAL_SOURCE_ENABLED: "true",
    },
  },
  production: {
    envName: "production",
    deployBranch: "production",
    vpcCidr: "10.41.0.0/16",
    natGateways: 1,
    rds: {
      instanceClass: "t4g.medium",
      multiAz: true,
      allocatedStorageGb: 50,
      backupRetentionDays: 30,
      deletionProtection: true,
    },
    redis: { nodeType: "cache.t4g.small", replicas: 1 },
    ecs: {
      api: { cpu: 1024, memoryMiB: 2048 },
      worker: { cpu: 1024, memoryMiB: 2048 },
      dispatcher: { cpu: 256, memoryMiB: 512 },
      clamav: { cpu: 1024, memoryMiB: 3072 },
      workerMaxCount: 4,
    },
    albIdleTimeoutSeconds: 180,
    mongoDbName: "dxg_rfp_tool_prod",
    aiEnvironment: {},
  },
};

/** GitHub repository allowed to assume the deploy roles via OIDC. */
export const GITHUB_REPOSITORY = "BayshoreCommunication/dxg-rfp-tool-backend";
