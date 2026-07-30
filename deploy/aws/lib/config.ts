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
  },
};

/** GitHub repository allowed to assume the deploy roles via OIDC. */
export const GITHUB_REPOSITORY = "BayshoreCommunication/dxg-rfp-tool-backend";
