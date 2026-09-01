/* Per-environment sizing and settings.
 *
 * Values that cannot be derived from the repository (account, domain,
 * certificate, alert email) are supplied via CDK context at synth time and
 * intentionally have no defaults — see README.md. Nothing here is a secret.
 */

export interface EnvironmentConfig {
  /** "production" — used in stack and resource names. */
  readonly envName: string;
  /** Git branch whose pushes may deploy this environment via OIDC. */
  readonly deployBranch: string;
  readonly vpcCidr: string;
  readonly natGateways: number;
  /** Interface VPC endpoints for ECR/Logs/Secrets. They exist to keep that
   *  traffic off the NAT gateway, but each endpoint bills per AZ per hour
   *  (~$58/month for the four of them across two subnets) while the traffic
   *  they divert measured ~1.3 GB/month — about $0.06 through NAT. Disabled
   *  in production for that reason; set true where private-only egress to
   *  AWS APIs is a compliance requirement rather than an optimisation.
   *  The S3 *gateway* endpoint is always created — gateway endpoints are
   *  free and carry the bulk of the object traffic. */
  readonly privateAwsEndpoints: boolean;
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
  readonly wafEnabled: boolean;
  readonly ecs: {
    readonly api: TaskSize;
    readonly worker: TaskSize;
    readonly dispatcher: TaskSize;
    readonly clamav: TaskSize;
    readonly workerMaxCount: number;
    readonly cronDesiredCount: number;
    readonly clamavDesiredCount: number;
  };
  /** ECS Container Insights. Publishes ~158 custom metrics for this cluster
   *  (~$47/month) and is the ONLY source of ECS/ContainerInsights
   *  RunningTaskCount. When false, observability-stack.ts substitutes a
   *  missing-data alarm on the standard AWS/ECS metrics — see the comment
   *  there before changing this, because the two are not equivalent. */
  readonly containerInsights: boolean;
  /** ALB idle timeout. The assistant SSE stream can be silent for up to
   *  120s before its first token; WebSocket clients get no server pings. */
  readonly albIdleTimeoutSeconds: number;
  /** MongoDB database name inside the env's Atlas cluster (MONGODB_DB_NAME). */
  readonly mongoDbName: string;
  /** Public base URL for app assets (ASSET_STORAGE_PUBLIC_URL_BASE) — the
   *  CloudFront domain in front of the assets bucket. Without it the app
   *  builds direct S3 URLs, which Block Public Access rejects. */
  readonly assetPublicUrlBase: string;
  /** Origins allowed to PUT directly to the documents bucket via presigned
   *  URLs (the admin knowledge-import flow). Everything else uploads
   *  server-side and needs no CORS entry. */
  readonly browserUploadOrigins: string[];
  /** Governed AI surface (deny-by-default). Empty = every AI flag absent,
   *  the platform's safe state. Populating this IS the AI release for the
   *  env (docs/runbooks/PRODUCTION.md). */
  readonly aiEnvironment: Record<string, string>;
}

export interface TaskSize {
  readonly cpu: number; // Fargate CPU units (1024 = 1 vCPU)
  readonly memoryMiB: number;
}

/* The governed AI surface, shared by every environment whose AI release has
 * been approved. Kept as a separate constant rather than inlined: it is the
 * single definition an environment opts into, so a flag cannot be added to
 * one environment and silently forgotten in another.
 *
 * Enabling AI is still explicit per environment: an environment opts in by
 * spreading this base. Omitting it (or `{}`) keeps the platform's
 * deny-by-default posture — that is how production shipped before its AI
 * release was approved.
 *
 * Model pin per docs/runbooks/PRODUCTION.md — changing it requires the gold
 * evaluation.
 */
const AI_RELEASE: Record<string, string> = {
  CONVERSATIONS_ENABLED: "true",
  CONVERSATION_EXTRACTION_ENABLED: "true",
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
  // Deterministic, review-gated room recommendations (engine room-rules.v3,
  // synthetic knowledge fixtures compiled into the backend — no data seeding
  // required). The dashboard has exposed this surface since its release, so a
  // deployed environment without the flag serves 503s on a visible feature.
  ROOM_RECOMMENDATIONS_ENABLED: "true",
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
  LIVE_AI_OUTPUT_TOKEN_LIMIT: "16000",
  LIVE_AI_NON_CONFIDENTIAL_ENABLED: "true",
  LIVE_AI_VENDOR_CONFIDENTIAL_ENABLED: "true",
  LIVE_AI_SYNTHETIC_ENABLED: "true",
  LIVE_AI_PROPOSAL_SOURCE_ENABLED: "true",
};

/* ⚠️ TEMPORARY PRE-LAUNCH COST POSTURE — set to false BEFORE real users.
 *
 * Production has no users yet (2026-08-18), so the redundancy that protects
 * against an AZ failure protects nobody: a single-AZ database and a
 * replica-less Redis save ~$61/month for a recovery window that currently
 * costs nothing. Durability is NOT affected — 30-day automated backups and
 * deletion protection both stay on. This trades AUTOMATIC failover for
 * MANUAL restore.
 *
 * Setting this to false and redeploying the Data stack restores Multi-AZ RDS
 * and the Redis replica. It is a LAUNCH BLOCKER, tracked in
 * deploy/aws/STATE.md — do not put real users on this posture.
 *
 * Both changes apply in place, and each causes a brief interruption when
 * applied AND again when reverted. Schedule them.
 */
export const PRE_LAUNCH_REDUCED_REDUNDANCY = true;

export const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  production: {
    envName: "production",
    deployBranch: "production",
    vpcCidr: "10.41.0.0/16",
    natGateways: 1,
    privateAwsEndpoints: false,
    rds: {
      instanceClass: "t4g.micro",
      multiAz: !PRE_LAUNCH_REDUCED_REDUNDANCY,
      allocatedStorageGb: 50,
      backupRetentionDays: 7,
      deletionProtection: true,
    },
    redis: { nodeType: "cache.t4g.micro", replicas: PRE_LAUNCH_REDUCED_REDUNDANCY ? 0 : 1 },
    wafEnabled: false,
    // CPU rightsized 2026-08-18 from 1024 on api/worker/clamav. Seven-day
    // observed utilisation at the time: api 2.3% avg / 8.8% peak, worker
    // 1.1% / 3.0%, clamav 1.1% / 1.8% — i.e. under a tenth of one vCPU.
    // Memory is deliberately NOT reduced: it is the headroom that absorbs
    // load, and clamd holds ~990 MiB of signature database. Revisit with
    // real traffic; autoscaling (workerMaxCount) is the intended answer to
    // load, not a larger steady-state task.
    ecs: {
      api: { cpu: 512, memoryMiB: 2048 },
      worker: { cpu: 512, memoryMiB: 2048 },
      dispatcher: { cpu: 256, memoryMiB: 512 },
      clamav: { cpu: 512, memoryMiB: 3072 },
      workerMaxCount: 4,
      cronDesiredCount: 0,
      clamavDesiredCount: 1,
    },
    containerInsights: false,
    albIdleTimeoutSeconds: 180,
    mongoDbName: "dxg_rfp_tool_prod",
    assetPublicUrlBase: "https://d1hn23mh1h53mx.cloudfront.net",
    browserUploadOrigins: [
      "https://av-rfpilot.com",
      "https://admin.av-rfpilot.com",
      "http://localhost:3001",
      "http://localhost:3000",
    ],
    aiEnvironment: { AI_ENVIRONMENT: "production", ...AI_RELEASE },
  },
};

/** GitHub repository allowed to assume the deploy roles via OIDC. */
export const GITHUB_REPOSITORY = "BayshoreCommunication/dxg-rfp-tool-backend";
