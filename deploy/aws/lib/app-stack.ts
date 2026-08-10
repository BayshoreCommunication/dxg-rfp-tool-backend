import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import { EnvironmentConfig } from "./config";
import { DataStack } from "./data-stack";
import { NetworkStack } from "./network-stack";

/* ECS cluster and the four services (api / worker / dispatcher / clamav),
 * ALB + WAF, the one-off migration task definition, and the CDN in front of
 * app assets. The api/worker/dispatcher containers run the same immutable
 * image (tag = git SHA via `-c imageTag=...`) with different commands.
 *
 * Deliberate choices, from the discovery report:
 * - API runs exactly 1 task, deployed stop-then-start (minHealthy 0): its
 *   cron jobs have no cross-replica locking and its WebSocket fan-out is
 *   process-local, so two live API tasks — even briefly during a rolling
 *   deploy — can duplicate destructive purges and drop notifications.
 * - ClamAV is a dedicated internal service (both API and worker scan).
 * - ALB health-checks GET / (static, dependency-free); GET /health couples
 *   to Mongo/PG/Redis and would evict every task on a dependency blip.
 * - Every AI flag stays unset (deny-by-default). Enabling AI is a separate,
 *   explicit release step — never part of infrastructure deployment.
 */
export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly apiService: ecs.FargateService;
  public readonly workerService: ecs.FargateService;
  public readonly dispatcherService: ecs.FargateService;
  public readonly clamavService: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    network: NetworkStack,
    data: DataStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const imageTag = this.node.tryGetContext("imageTag") ?? "bootstrap";
    const certificateArn = this.node.tryGetContext("certificateArn") as string | undefined;
    const apiDomain = (this.node.tryGetContext("apiDomain") as string | undefined) ?? "";
    const frontendUrl = (this.node.tryGetContext("frontendUrl") as string | undefined) ?? "";
    const adminUrl = (this.node.tryGetContext("adminUrl") as string | undefined) ?? "";

    const repository = ecr.Repository.fromRepositoryName(this, "Repo", "rfpilot-backend");
    const appImage = ecs.ContainerImage.fromEcrRepository(repository, imageTag);

    // Imported views of the Data stack's resources. Granting against imports
    // keeps every permission in THIS stack's identity policies; granting
    // against the real constructs would edit the KMS key/bucket policies in
    // the Data stack and create a cross-stack dependency cycle. The CMK's
    // default policy delegates to IAM identity policies, so this is
    // sufficient. The app secret uses the AWS-managed Secrets Manager key.
    const dataKey = kms.Key.fromKeyArn(this, "DataKeyRef", data.dataKey.keyArn);
    const documentsBucket = s3.Bucket.fromBucketAttributes(this, "DocumentsBucketRef", {
      bucketArn: data.documentsBucket.bucketArn,
      encryptionKey: dataKey,
    });
    const assetsBucket = s3.Bucket.fromBucketAttributes(this, "AssetsBucketRef", {
      bucketArn: data.assetsBucket.bucketArn,
      encryptionKey: dataKey,
    });
    const appSecret = secretsmanager.Secret.fromSecretCompleteArn(this, "AppSecretRef", data.appSecret.secretArn);

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: network.vpc,
      clusterName: `rfpilot-${config.envName}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: {
        name: `rfpilot-${config.envName}.local`,
        useForServiceConnect: true,
      },
    });

    const logGroup = (name: string): logs.LogGroup =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/rfpilot/${config.envName}/${name.toLowerCase()}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    // Non-secret configuration shared by api, worker, dispatcher, migrate.
    // Everything AI-related is intentionally ABSENT: AI_ENVIRONMENT unset is
    // the platform's deny-by-default state.
    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "8000",
      MONGODB_DB_NAME: config.mongoDbName,
      ASSET_STORAGE_PUBLIC_URL_BASE: config.assetPublicUrlBase,
      ...config.aiEnvironment,
      POSTGRES_FOUNDATION_ENABLED: "true",
      POSTGRES_SSL: "true",
      NODE_EXTRA_CA_CERTS: "/app/rds-global-bundle.pem",
      /* Without this safeLog returns early and the only thing reaching
         CloudWatch is morgan's access line, so a failed request cannot be
         traced by its correlation id. OTEL_EXPORTER_OTLP_ENDPOINT stays unset
         on purpose: there is no collector sidecar in these task definitions,
         and config/observability.ts skips the exporter when no endpoint is
         configured, so this buys the structured stdout logs without an
         export-retry loop. Set the endpoint if a collector is ever added. */
      OBSERVABILITY_ENABLED: "true",
      DURABLE_JOBS_ENABLED: "true",
      DOCUMENT_INGESTION_ENABLED: "true",
      DOCUMENT_STORAGE_BUCKET: documentsBucket.bucketName,
      DOCUMENT_STORAGE_REGION: this.region,
      ASSET_STORAGE_BUCKET: assetsBucket.bucketName,
      ASSET_STORAGE_REGION: this.region,
      VENDOR_UPLOAD_SCAN_REQUIRED: "true",
      CLAMAV_HOST: "clamav",
      CLAMAV_PORT: "3310",
      ...(frontendUrl ? { FRONTEND_URL: frontendUrl } : {}),
      ...(adminUrl ? { ADMIN_URL: adminUrl } : {}),
      ...(apiDomain ? { BACKEND_URL: `https://${apiDomain}` } : {}),
    };

    const secret = (field: string): ecs.Secret => ecs.Secret.fromSecretsManager(appSecret, field);
    const sharedSecrets: Record<string, ecs.Secret> = {
      MONGODB_URL: secret("MONGODB_URL"),
      POSTGRES_URL: secret("POSTGRES_URL"),
      REDIS_URL: secret("REDIS_URL"),
      JWT_SECRET: secret("JWT_SECRET"),
      OTP_PEPPER: secret("OTP_PEPPER"),
      TELEMETRY_PSEUDONYM_KEY: secret("TELEMETRY_PSEUDONYM_KEY"),
      OPENAI_API_KEY: secret("OPENAI_API_KEY"),
    };
    const apiOnlySecrets: Record<string, ecs.Secret> = {
      BFF_SHARED_SECRET: secret("BFF_SHARED_SECRET"),
      ADMIN_SIGNUP_SECRET: secret("ADMIN_SIGNUP_SECRET"),
      AI_SAFETY_IDENTIFIER_SECRET: secret("AI_SAFETY_IDENTIFIER_SECRET"),
      GOOGLE_CLIENT_ID: secret("GOOGLE_CLIENT_ID"),
      SMTP_HOST: secret("SMTP_HOST"),
      SMTP_PORT: secret("SMTP_PORT"),
      SMTP_MAIL: secret("SMTP_MAIL"),
      SMTP_USER: secret("SMTP_USER"),
      SMTP_PASSWORD: secret("SMTP_PASSWORD"),
    };

    const makeTaskDefinition = (
      name: string,
      size: { cpu: number; memoryMiB: number },
    ): ecs.FargateTaskDefinition => {
      const definition = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        family: `rfpilot-${config.envName}-${name.toLowerCase()}`,
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      return definition;
    };

    /* ── API ─────────────────────────────────────────────────────────── */
    const apiTaskDef = makeTaskDefinition("Api", config.ecs.api);
    apiTaskDef.addContainer("api", {
      image: appImage,
      command: ["node", "dist/server.js"],
      environment: { ...sharedEnvironment, CRON_ENABLED: "true" },
      secrets: { ...sharedSecrets, ...apiOnlySecrets },
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("Api"), streamPrefix: "api" }),
      portMappings: [{ containerPort: 8000, name: "api" }],
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:8000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        startPeriod: cdk.Duration.seconds(60),
        interval: cdk.Duration.seconds(30),
        retries: 3,
      },
      stopTimeout: cdk.Duration.seconds(30),
    });
    // Task-role S3 access: presign/put/get/delete on both buckets via KMS.
    documentsBucket.grantReadWrite(apiTaskDef.taskRole);
    documentsBucket.grantDelete(apiTaskDef.taskRole);
    assetsBucket.grantReadWrite(apiTaskDef.taskRole);
    assetsBucket.grantDelete(apiTaskDef.taskRole);

    this.apiService = new ecs.FargateService(this, "ApiService", {
      cluster: this.cluster,
      serviceName: "api",
      taskDefinition: apiTaskDef,
      desiredCount: 1,
      securityGroups: [network.apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Stop-then-start (see header comment): never two API tasks at once.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      serviceConnectConfiguration: {},
      enableExecuteCommand: false,
    });

    /* ── Worker ──────────────────────────────────────────────────────── */
    const workerTaskDef = makeTaskDefinition("Worker", config.ecs.worker);
    workerTaskDef.addContainer("worker", {
      image: appImage,
      command: ["node", "dist/scripts/startDurableWorker.js"],
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("Worker"), streamPrefix: "worker" }),
      // Graceful drain: worker.close() waits for active jobs; leases run to
      // JOB_LEASE_SECONDS (90s), so give SIGTERM the full 120s ECS maximum.
      stopTimeout: cdk.Duration.seconds(120),
    });
    documentsBucket.grantReadWrite(workerTaskDef.taskRole);
    documentsBucket.grantDelete(workerTaskDef.taskRole);
    assetsBucket.grantRead(workerTaskDef.taskRole);

    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: this.cluster,
      serviceName: "worker",
      taskDefinition: workerTaskDef,
      desiredCount: 1,
      securityGroups: [network.workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      serviceConnectConfiguration: {},
    });
    // The API may begin producing newly introduced job types as soon as its
    // task definition rolls. Stabilize the compatible worker first so an old
    // consumer can never mis-handle a new message during a deployment.
    this.apiService.node.addDependency(this.workerService);
    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: config.ecs.workerMaxCount,
    });
    workerScaling.scaleOnCpuUtilization("WorkerCpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    /* ── Dispatcher ──────────────────────────────────────────────────── */
    const dispatcherTaskDef = makeTaskDefinition("Dispatcher", config.ecs.dispatcher);
    dispatcherTaskDef.addContainer("dispatcher", {
      image: appImage,
      command: ["node", "dist/scripts/startDurableDispatcher.js"],
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("Dispatcher"), streamPrefix: "dispatcher" }),
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.dispatcherService = new ecs.FargateService(this, "DispatcherService", {
      cluster: this.cluster,
      serviceName: "dispatcher",
      taskDefinition: dispatcherTaskDef,
      desiredCount: 1,
      securityGroups: [network.dispatcherSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Overlap is safe: outbox claims use FOR UPDATE SKIP LOCKED.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
    });

    /* ── AI gateway worker ───────────────────────────────────────────── */
    // The platform assistant's job pipeline runs as its own process (see
    // scripts/startAiGatewayWorker.ts). Only materializes when the env's
    // AI release (config.aiEnvironment) enables the gateway — production's
    // empty map means no service, matching deny-by-default.
    if (config.aiEnvironment.AI_GATEWAY_ENABLED === "true") {
      const aiGatewayTaskDef = makeTaskDefinition("AiGateway", config.ecs.dispatcher);
      aiGatewayTaskDef.addContainer("ai-gateway", {
        image: appImage,
        command: ["node", "dist/scripts/startAiGatewayWorker.js"],
        environment: sharedEnvironment,
        secrets: sharedSecrets,
        logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("AiGateway"), streamPrefix: "ai-gateway" }),
        stopTimeout: cdk.Duration.seconds(30),
      });
      new ecs.FargateService(this, "AiGatewayService", {
        cluster: this.cluster,
        serviceName: "ai-gateway",
        taskDefinition: aiGatewayTaskDef,
        desiredCount: 1,
        securityGroups: [network.dispatcherSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
      });
    }

    /* ── ClamAV ──────────────────────────────────────────────────────── */
    const clamavTaskDef = makeTaskDefinition("Clamav", config.ecs.clamav);
    clamavTaskDef.addContainer("clamav", {
      // Official image; freshclam refreshes signatures at runtime (egress via
      // NAT to database.clamav.net). Pinned major tag; digest-pin at upgrade.
      image: ecs.ContainerImage.fromRegistry("clamav/clamav:1.4"),
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("Clamav"), streamPrefix: "clamav" }),
      portMappings: [{ containerPort: 3310, name: "clamav" }],
      healthCheck: {
        command: ["CMD-SHELL", "clamdcheck.sh || exit 1"],
        // First start downloads the full signature database.
        startPeriod: cdk.Duration.minutes(5),
        interval: cdk.Duration.seconds(30),
        retries: 3,
      },
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.clamavService = new ecs.FargateService(this, "ClamavService", {
      cluster: this.cluster,
      serviceName: "clamav",
      taskDefinition: clamavTaskDef,
      desiredCount: 1,
      securityGroups: [network.clamavSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      serviceConnectConfiguration: {
        services: [
          {
            portMappingName: "clamav",
            discoveryName: "clamav",
            dnsName: "clamav",
            port: 3310,
          },
        ],
      },
    });

    /* ── One-off migration task definition ───────────────────────────── */
    const migrateTaskDef = makeTaskDefinition("Migrate", { cpu: 512, memoryMiB: 1024 });
    migrateTaskDef.addContainer("migrate", {
      image: appImage,
      command: ["node", "dist/scripts/migratePostgres.js", "up"],
      environment: sharedEnvironment,
      secrets: {
        POSTGRES_URL: secret("POSTGRES_URL"),
        POSTGRES_MIGRATION_URL: secret("POSTGRES_MIGRATION_URL"),
        /* Not used by the migrator today, but safeTelemetry throws on import
           when observability is enabled in production without it. This task
           shares sharedEnvironment, so one future import anywhere in the
           migration path would otherwise fail every deployment's migrate step
           rather than anything obviously telemetry-shaped. */
        TELEMETRY_PSEUDONYM_KEY: secret("TELEMETRY_PSEUDONYM_KEY"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup("Migrate"), streamPrefix: "migrate" }),
    });

    /* ── ALB + WAF ───────────────────────────────────────────────────── */
    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSg,
      idleTimeout: cdk.Duration.seconds(config.albIdleTimeoutSeconds),
      dropInvalidHeaderFields: true,
    });

    // ELB log delivery supports only SSE-S3, not KMS.
    const albLogsBucket = new s3.Bucket(this, "AlbLogsBucket", {
      bucketName: `rfpilot-${config.envName}-alb-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.alb.logAccessLogs(albLogsBucket, "alb");

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "ApiTargets", {
      vpc: network.vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30),
      healthCheck: {
        path: "/",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.apiService.attachToApplicationTargetGroup(targetGroup);

    if (certificateArn) {
      this.alb.addListener("Https", {
        port: 443,
        certificates: [acm.Certificate.fromCertificateArn(this, "Cert", certificateArn)],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
      });
      // Same construct id as the bootstrap listener below: port 80 is
      // occupied, so this must be an in-place default-action update, not a
      // create-before-delete replacement (listener creates collide on port).
      this.alb.addListener("Http", {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
      });
    } else {
      // Bootstrap mode before a certificate exists. Replaced by HTTPS as soon
      // as `-c certificateArn=...` is supplied.
      this.alb.addListener("Http", { port: 80, defaultTargetGroups: [targetGroup] });
    }

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `rfpilot-${config.envName}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              // The app legitimately accepts up to 50 MB document uploads;
              // the size restriction rule would block them at 8 KB.
              excludedRules: [{ name: "SizeRestrictions_BODY" }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "common-rules",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitPerIp",
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "rate-limit",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });


    /* ── Outputs consumed by the deploy workflow and runbook ─────────── */
    new cdk.CfnOutput(this, "AlbDnsName", { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, "MigrateTaskDefinitionArn", { value: migrateTaskDef.taskDefinitionArn });
    new cdk.CfnOutput(this, "MigrateSecurityGroupId", { value: network.migrateSg.securityGroupId });
    new cdk.CfnOutput(this, "PrivateSubnetIds", {
      value: network.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(","),
    });
  }
}
