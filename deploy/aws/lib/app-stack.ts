import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config';
import { DataStack } from './data-stack';
import { NetworkStack } from './network-stack';

/* ECS cluster and the API / cron / worker / dispatcher / clamav services,
 * ALB + WAF, the one-off migration task definition, and the CDN in front of
 * app assets. The api/worker/dispatcher containers run the same immutable
 * image (tag = git SHA via `-c imageTag=...`) with different commands.
 *
 * Deliberate choices, from the discovery report:
 * - API runs exactly 1 steady-state task but rolls with one-task overlap so
 *   the ALB always has a healthy target. Singleton cron work runs in its own
 *   stop-then-start service, where overlap cannot duplicate destructive jobs.
 * - ClamAV is a dedicated internal service (both API and worker scan).
 * - ALB health-checks GET / (static, dependency-free); GET /health couples
 *   to Mongo/PG/Redis and would evict every task on a dependency blip.
 * - Every AI flag stays unset (deny-by-default). Enabling AI is a separate,
 *   explicit release step — never part of infrastructure deployment.
 */
export class AppStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly apiService: ecs.FargateService;
  public readonly cronService: ecs.FargateService;
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

    // Used only by the release workflow when migrating an existing service
    // from stop-first (0/100) to rolling (100/200). That first phase preserves
    // the current API task definition and omits the not-yet-deployed cron
    // service, so CloudFormation changes only DeploymentConfiguration.
    const rolloutPolicyOnly =
      this.node.tryGetContext('rolloutPolicyOnly') === 'true';

    const imageTag =
      this.node.tryGetContext('imageTag') ?? 'bootstrap';
    const certificateArn = this.node.tryGetContext(
      'certificateArn',
    ) as string | undefined;
    const apiDomain =
      (this.node.tryGetContext('apiDomain') as string | undefined) ??
      '';
    const frontendUrl =
      (this.node.tryGetContext('frontendUrl') as
        string | undefined) ?? '';
    const adminUrl =
      (this.node.tryGetContext('adminUrl') as string | undefined) ??
      '';

    const repository = ecr.Repository.fromRepositoryName(
      this,
      'Repo',
      'rfpilot-backend',
    );
    const appImage = ecs.ContainerImage.fromEcrRepository(
      repository,
      imageTag,
    );

    // Imported views of the Data stack's resources. Granting against imports
    // keeps every permission in THIS stack's identity policies; granting
    // against the real constructs would edit the KMS key/bucket policies in
    // the Data stack and create a cross-stack dependency cycle. The CMK's
    // default policy delegates to IAM identity policies, so this is
    // sufficient. The app secret uses the AWS-managed Secrets Manager key.
    const dataKey = kms.Key.fromKeyArn(
      this,
      'DataKeyRef',
      data.dataKey.keyArn,
    );
    const documentsBucket = s3.Bucket.fromBucketAttributes(
      this,
      'DocumentsBucketRef',
      {
        bucketArn: data.documentsBucket.bucketArn,
        encryptionKey: dataKey,
      },
    );
    const assetsBucket = s3.Bucket.fromBucketAttributes(
      this,
      'AssetsBucketRef',
      {
        bucketArn: data.assetsBucket.bucketArn,
        encryptionKey: dataKey,
      },
    );
    const appSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AppSecretRef',
      data.appSecret.secretArn,
    );

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      clusterName: `rfpilot-${config.envName}`,
      // ~158 custom metrics for this cluster (~$47/month). Off in production;
      // observability-stack.ts compensates — read the comment on the
      // tasks-low alarms there before flipping this back.
      containerInsightsV2: config.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
      defaultCloudMapNamespace: {
        name: `rfpilot-${config.envName}.local`,
        useForServiceConnect: true,
      },
    });

    const logGroup = (name: string): logs.LogGroup =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/rfpilot/${config.envName}/${name.toLowerCase()}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    // Non-secret configuration shared by api, worker, dispatcher, migrate.
    // Everything AI-related is intentionally ABSENT: AI_ENVIRONMENT unset is
    // the platform's deny-by-default state.
    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '8000',
      MONGODB_DB_NAME: config.mongoDbName,
      ASSET_STORAGE_PUBLIC_URL_BASE: config.assetPublicUrlBase,
      ...config.aiEnvironment,
      POSTGRES_FOUNDATION_ENABLED: 'true',
      /* Writes rfpilot.proposal_references when a proposal is created,
         updated or copied. Without it the row only appears once a chat
         message repairs it on demand, so the first document upload on a
         brand-new proposal failed with PROPOSAL_NOT_FOUND
         (docs/architecture/POSTGRES_DATA_FOUNDATION.md, "Dual-write
         behavior"). The write is best-effort and never blocks the MongoDB
         proposal write. */
      PROPOSAL_REFERENCE_DUAL_WRITE_ENABLED: 'true',
      POSTGRES_SSL: 'true',
      NODE_EXTRA_CA_CERTS: '/app/rds-global-bundle.pem',
      /* Without this safeLog returns early and the only thing reaching
         CloudWatch is morgan's access line, so a failed request cannot be
         traced by its correlation id. OTEL_EXPORTER_OTLP_ENDPOINT stays unset
         on purpose: there is no collector sidecar in these task definitions,
         and config/observability.ts skips the exporter when no endpoint is
         configured, so this buys the structured stdout logs without an
         export-retry loop. Set the endpoint if a collector is ever added. */
      OBSERVABILITY_ENABLED: 'true',
      DURABLE_JOBS_ENABLED: 'true',
      DOCUMENT_INGESTION_ENABLED: 'true',
      DOCUMENT_STORAGE_BUCKET: documentsBucket.bucketName,
      DOCUMENT_STORAGE_REGION: this.region,
      ASSET_STORAGE_BUCKET: assetsBucket.bucketName,
      ASSET_STORAGE_REGION: this.region,
      VENDOR_UPLOAD_SCAN_REQUIRED: 'true',
      // The legacy public submission route has been retired. Existing
      // proposal markers are migrated to structured_v1 by the audited
      // production cutover task.
      VENDOR_STRUCTURED_RESPONSES_ENABLED: 'true',
      CLAMAV_HOST: 'clamav',
      CLAMAV_PORT: '3310',
      ...(frontendUrl ? { FRONTEND_URL: frontendUrl } : {}),
      ...(adminUrl ? { ADMIN_URL: adminUrl } : {}),
      ...(config.supportNotifyEmail
        ? {
            SUPPORT_DESK_EMAIL_NOTIFICATIONS: 'true',
            SUPPORT_DESK_NOTIFY_EMAIL: config.supportNotifyEmail,
          }
        : {}),
      ...(apiDomain ? { BACKEND_URL: `https://${apiDomain}` } : {}),
    };

    const secret = (field: string): ecs.Secret =>
      ecs.Secret.fromSecretsManager(appSecret, field);
    const sharedSecrets: Record<string, ecs.Secret> = {
      MONGODB_URL: secret('MONGODB_URL'),
      POSTGRES_URL: secret('POSTGRES_URL'),
      REDIS_URL: secret('REDIS_URL'),
      JWT_SECRET: secret('JWT_SECRET'),
      OTP_PEPPER: secret('OTP_PEPPER'),
      TELEMETRY_PSEUDONYM_KEY: secret('TELEMETRY_PSEUDONYM_KEY'),
      OPENAI_API_KEY: secret('OPENAI_API_KEY'),
    };
    const apiOnlySecrets: Record<string, ecs.Secret> = {
      BFF_SHARED_SECRET: secret('BFF_SHARED_SECRET'),
      ADMIN_SIGNUP_SECRET: secret('ADMIN_SIGNUP_SECRET'),
      AI_SAFETY_IDENTIFIER_SECRET: secret(
        'AI_SAFETY_IDENTIFIER_SECRET',
      ),
      GOOGLE_CLIENT_ID: secret('GOOGLE_CLIENT_ID'),
      // Seal TOTP seeds and company-SSO client secrets. The keys must exist in
      // the app secret before this deploys (compose-app-secrets.sh generates
      // them), or the tasks can't start.
      TWO_FACTOR_ENCRYPTION_KEY: secret('TWO_FACTOR_ENCRYPTION_KEY'),
      SSO_SECRET_KEY: secret('SSO_SECRET_KEY'),
      SMTP_HOST: secret('SMTP_HOST'),
      SMTP_PORT: secret('SMTP_PORT'),
      SMTP_MAIL: secret('SMTP_MAIL'),
      SMTP_USER: secret('SMTP_USER'),
      SMTP_PASSWORD: secret('SMTP_PASSWORD'),
    };

    const makeTaskDefinition = (
      name: string,
      size: { cpu: number; memoryMiB: number },
    ): ecs.FargateTaskDefinition => {
      const definition = new ecs.FargateTaskDefinition(
        this,
        `${name}TaskDef`,
        {
          family: `rfpilot-${config.envName}-${name.toLowerCase()}`,
          cpu: size.cpu,
          memoryLimitMiB: size.memoryMiB,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          },
        },
      );
      return definition;
    };

    /* ── API ─────────────────────────────────────────────────────────── */
    const apiTaskDef = makeTaskDefinition('Api', config.ecs.api);
    const apiContainer = apiTaskDef.addContainer('api', {
      image: appImage,
      command: ['node', 'dist/server.js'],
      environment: {
        ...sharedEnvironment,
        CRON_ENABLED: rolloutPolicyOnly ? 'true' : 'false',
      },
      secrets: { ...sharedSecrets, ...apiOnlySecrets },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Api'),
        streamPrefix: 'api',
      }),
      portMappings: [{ containerPort: 8000, name: 'api' }],
      healthCheck: {
        command: [
          'CMD-SHELL',
          'node -e "fetch(\'http://127.0.0.1:8000/\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
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

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster: this.cluster,
      serviceName: 'api',
      taskDefinition: apiTaskDef,
      desiredCount: 1,
      securityGroups: [network.apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Keep the old healthy target registered until its replacement passes
      // container and ALB checks. Singleton mutations live in cronService, so
      // a short API overlap is safe and production never drops to zero targets.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      serviceConnectConfiguration: {},
      enableExecuteCommand: false,
    });

    /* ── Singleton cron worker ───────────────────────────────────────── */
    if (rolloutPolicyOnly) {
      // Observability is synthesized alongside this stack but is not deployed
      // in the policy-only phase. Keep its non-optional service reference
      // valid without creating any cron resources in the App template.
      this.cronService = this.apiService;
    } else {
      const cronTaskDef = makeTaskDefinition(
        'Cron',
        config.ecs.dispatcher,
      );
      cronTaskDef.addContainer('cron', {
        image: appImage,
        command: ['node', 'dist/scripts/startCronWorker.js'],
        environment: sharedEnvironment,
        // Keep startup parity with the proven API task. Some cron imports load
        // shared application modules eagerly, so a reduced secret set can make
        // the container exit before the scheduler starts even when a particular
        // job would only use Mongo/Postgres at runtime.
        secrets: { ...sharedSecrets, ...apiOnlySecrets },
        logging: ecs.LogDrivers.awsLogs({
          logGroup: logGroup('Cron'),
          streamPrefix: 'cron',
        }),
        stopTimeout: cdk.Duration.seconds(120),
      });
      documentsBucket.grantReadWrite(cronTaskDef.taskRole);
      documentsBucket.grantDelete(cronTaskDef.taskRole);

      this.cronService = new ecs.FargateService(
        this,
        'CronService',
        {
          cluster: this.cluster,
          serviceName: 'cron',
          taskDefinition: cronTaskDef,
          desiredCount: config.ecs.cronDesiredCount,
          // Use the same outbound/network posture as the API, where these jobs
          // previously ran successfully in-process. The cron task has no ALB
          // target, so the API security group's ingress rule is never exercised.
          securityGroups: [network.apiSg],
          vpcSubnets: {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          // The jobs run immediately on startup and do not use a distributed
          // lease. Preserve singleton execution by replacing without overlap.
          minHealthyPercent: 0,
          maxHealthyPercent: 100,
          circuitBreaker: { enable: true, rollback: true },
        },
      );
    }

    /* ── Worker ──────────────────────────────────────────────────────── */
    const workerTaskDef = makeTaskDefinition(
      'Worker',
      config.ecs.worker,
    );
    workerTaskDef.addContainer('worker', {
      image: appImage,
      command: ['node', 'dist/scripts/startDurableWorker.js'],
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Worker'),
        streamPrefix: 'worker',
      }),
      // Graceful drain: worker.close() waits for active jobs; leases run to
      // JOB_LEASE_SECONDS (90s), so give SIGTERM the full 120s ECS maximum.
      stopTimeout: cdk.Duration.seconds(120),
    });
    documentsBucket.grantReadWrite(workerTaskDef.taskRole);
    documentsBucket.grantDelete(workerTaskDef.taskRole);
    assetsBucket.grantRead(workerTaskDef.taskRole);

    this.workerService = new ecs.FargateService(
      this,
      'WorkerService',
      {
        cluster: this.cluster,
        serviceName: 'worker',
        taskDefinition: workerTaskDef,
        desiredCount: 1,
        securityGroups: [network.workerSg],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
        serviceConnectConfiguration: {},
      },
    );
    // The API may begin producing newly introduced job types as soon as its
    // task definition rolls. Stabilize the compatible worker first so an old
    // consumer can never mis-handle a new message during a deployment.
    this.apiService.node.addDependency(this.workerService);
    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: config.ecs.workerMaxCount,
    });
    workerScaling.scaleOnCpuUtilization('WorkerCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    /* ── Dispatcher ──────────────────────────────────────────────────── */
    const dispatcherTaskDef = makeTaskDefinition(
      'Dispatcher',
      config.ecs.dispatcher,
    );
    dispatcherTaskDef.addContainer('dispatcher', {
      image: appImage,
      command: ['node', 'dist/scripts/startDurableDispatcher.js'],
      environment: sharedEnvironment,
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Dispatcher'),
        streamPrefix: 'dispatcher',
      }),
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.dispatcherService = new ecs.FargateService(
      this,
      'DispatcherService',
      {
        cluster: this.cluster,
        serviceName: 'dispatcher',
        taskDefinition: dispatcherTaskDef,
        desiredCount: 1,
        securityGroups: [network.dispatcherSg],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        // Overlap is safe: outbox claims use FOR UPDATE SKIP LOCKED.
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
      },
    );

    /* ── AI gateway worker ───────────────────────────────────────────── */
    // The platform assistant's job pipeline runs as its own process (see
    // scripts/startAiGatewayWorker.ts). Only materializes when the env's
    // AI release (config.aiEnvironment) enables the gateway — production's
    // empty map means no service, matching deny-by-default.
    if (config.aiEnvironment.AI_GATEWAY_ENABLED === 'true') {
      const aiGatewayTaskDef = makeTaskDefinition(
        'AiGateway',
        config.ecs.dispatcher,
      );
      aiGatewayTaskDef.addContainer('ai-gateway', {
        image: appImage,
        command: ['node', 'dist/scripts/startAiGatewayWorker.js'],
        environment: sharedEnvironment,
        secrets: sharedSecrets,
        logging: ecs.LogDrivers.awsLogs({
          logGroup: logGroup('AiGateway'),
          streamPrefix: 'ai-gateway',
        }),
        stopTimeout: cdk.Duration.seconds(30),
      });
      new ecs.FargateService(this, 'AiGatewayService', {
        cluster: this.cluster,
        serviceName: 'ai-gateway',
        taskDefinition: aiGatewayTaskDef,
        desiredCount: 1,
        securityGroups: [network.dispatcherSg],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { enable: true, rollback: true },
      });
    }

    /* ── ClamAV ──────────────────────────────────────────────────────── */
    const clamavTaskDef = makeTaskDefinition(
      'Clamav',
      config.ecs.clamav,
    );
    clamavTaskDef.addContainer('clamav', {
      // Official image; freshclam refreshes signatures at runtime (egress via
      // NAT to database.clamav.net). Pinned major tag; digest-pin at upgrade.
      image: ecs.ContainerImage.fromRegistry('clamav/clamav:1.4'),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Clamav'),
        streamPrefix: 'clamav',
      }),
      portMappings: [{ containerPort: 3310, name: 'clamav' }],
      healthCheck: {
        command: ['CMD-SHELL', 'clamdcheck.sh || exit 1'],
        // First start downloads the full signature database.
        startPeriod: cdk.Duration.minutes(5),
        interval: cdk.Duration.seconds(30),
        retries: 3,
      },
      stopTimeout: cdk.Duration.seconds(30),
    });

    this.clamavService = new ecs.FargateService(
      this,
      'ClamavService',
      {
        cluster: this.cluster,
        serviceName: 'clamav',
        taskDefinition: clamavTaskDef,
        desiredCount: config.ecs.clamavDesiredCount,
        securityGroups: [network.clamavSg],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        minHealthyPercent: 0,
        maxHealthyPercent: 100,
        circuitBreaker: { enable: true, rollback: true },
        serviceConnectConfiguration: {
          services: [
            {
              portMappingName: 'clamav',
              discoveryName: 'clamav',
              dnsName: 'clamav',
              port: 3310,
            },
          ],
        },
      },
    );

    /* ── One-off migration task definition ───────────────────────────── */
    const migrateTaskDef = makeTaskDefinition('Migrate', {
      cpu: 512,
      memoryMiB: 1024,
    });
    migrateTaskDef.addContainer('migrate', {
      image: appImage,
      command: ['node', 'dist/scripts/migratePostgres.js', 'up'],
      environment: sharedEnvironment,
      secrets: {
        POSTGRES_URL: secret('POSTGRES_URL'),
        POSTGRES_MIGRATION_URL: secret('POSTGRES_MIGRATION_URL'),
        /* For one-off runs of scripts/placeLegacyCustomer.js (ORG-110), which moves an account's
           MongoDB documents and Postgres rows together and so needs both stores. The migrator
           itself never reads it. */
        MONGODB_URL: secret('MONGODB_URL'),
        /* Not used by the migrator today, but safeTelemetry throws on import
           when observability is enabled in production without it. This task
           shares sharedEnvironment, so one future import anywhere in the
           migration path would otherwise fail every deployment's migrate step
           rather than anything obviously telemetry-shaped. */
        TELEMETRY_PSEUDONYM_KEY: secret('TELEMETRY_PSEUDONYM_KEY'),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Migrate'),
        streamPrefix: 'migrate',
      }),
    });

    /* ── ALB + WAF ───────────────────────────────────────────────────── */
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSg,
      idleTimeout: cdk.Duration.seconds(config.albIdleTimeoutSeconds),
      dropInvalidHeaderFields: true,
    });

    // ELB log delivery supports only SSE-S3, not KMS.
    const albLogsBucket = new s3.Bucket(this, 'AlbLogsBucket', {
      bucketName: `rfpilot-${config.envName}-alb-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.alb.logAccessLogs(albLogsBucket, 'alb');

    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'ApiTargets',
      {
        vpc: network.vpc,
        port: 8000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: cdk.Duration.seconds(30),
        healthCheck: {
          path: '/',
          healthyHttpCodes: '200',
          interval: cdk.Duration.seconds(15),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      },
    );
    this.apiService.attachToApplicationTargetGroup(targetGroup);

    if (certificateArn) {
      this.alb.addListener('Https', {
        port: 443,
        open: false, // ingress owned by NetworkStack's albSg, not context-dependent auto-connections
        certificates: [
          acm.Certificate.fromCertificateArn(
            this,
            'Cert',
            certificateArn,
          ),
        ],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
      });
      // Same construct id as the bootstrap listener below: port 80 is
      // occupied, so this must be an in-place default-action update, not a
      // create-before-delete replacement (listener creates collide on port).
      this.alb.addListener('Http', {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      // Bootstrap mode before a certificate exists. Replaced by HTTPS as soon
      // as `-c certificateArn=...` is supplied.
      this.alb.addListener('Http', {
        port: 80,
        open: false,
        defaultTargetGroups: [targetGroup],
      });
    }

    if (config.wafEnabled) {
      const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `rfpilot-${config.envName}-waf`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AWSManagedCommonRuleSet',
            priority: 1,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
                // The app legitimately accepts up to 50 MB document uploads;
                // the size restriction rule would block them at 8 KB.
                excludedRules: [{ name: 'SizeRestrictions_BODY' }],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'common-rules',
              sampledRequestsEnabled: true,
            },
          },
          {
            name: 'RateLimitPerIp',
            priority: 2,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                limit: 2000,
                aggregateKeyType: 'IP',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'rate-limit',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
        resourceArn: this.alb.loadBalancerArn,
        webAclArn: webAcl.attrArn,
      });
    }

    /* ── Outputs consumed by the deploy workflow and runbook ─────────── */
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
    });
    new cdk.CfnOutput(this, 'MigrateTaskDefinitionArn', {
      value: migrateTaskDef.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'MigrateSecurityGroupId', {
      value: network.migrateSg.securityGroupId,
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: network.vpc
        .selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        })
        .subnetIds.join(','),
    });

    /* ── Legacy-customer placement: API → Step Functions → one task ──── */
    // Owner's decision, 2026-11-17 (docs/DECISIONS.md). Placing a legacy
    // customer moves Postgres rows between organizations, which needs the
    // table-owner role. The API never gets POSTGRES_MIGRATION_URL, and it
    // does not get ecs:RunTask either: IAM cannot restrict RunTask's
    // overrides (command, environment, task role, network), so permission to
    // run a task that holds the migration role is the migration role.
    //
    // Instead the API may start executions of ONE state machine. Everything
    // about the task is fixed in the state machine's definition below; the
    // only thing taken from the execution input is `$.runId`, placed as one
    // argv element. The task definition is dedicated to placement: its entry
    // point is a script that accepts only that argument, and it holds only
    // the two secrets the move needs.
    //
    // What is left to trust is the placement journal in MongoDB, which the
    // API writes and the task reads: see the decision row.
    const placementTaskDef = makeTaskDefinition('Placement', {
      cpu: 512,
      memoryMiB: 1024,
    });
    placementTaskDef.addContainer('placement', {
      image: appImage,
      // tini as in the image's own ENTRYPOINT (signal forwarding), then the
      // one script. The command is only ever the run-id argument; with none
      // the script prints its usage and exits non-zero.
      entryPoint: [
        '/usr/bin/tini',
        '--',
        'node',
        'dist/scripts/runPlacementTask.js',
      ],
      command: [],
      // Only what the script reads. No observability flag, so nothing on
      // its import path needs the telemetry key (see the migrate task).
      environment: {
        NODE_ENV: 'production',
        MONGODB_DB_NAME: config.mongoDbName,
        POSTGRES_FOUNDATION_ENABLED: 'true',
        POSTGRES_SSL: 'true',
        NODE_EXTRA_CA_CERTS: '/app/rds-global-bundle.pem',
        // The cutover runbook's lock timeout for work on a live product:
        // wait 15 s for a lock, then fail with nothing moved.
        PGOPTIONS: '-c lock_timeout=15000',
      },
      secrets: {
        MONGODB_URL: secret('MONGODB_URL'),
        POSTGRES_MIGRATION_URL: secret('POSTGRES_MIGRATION_URL'),
      },
      // The script writes nothing to disk.
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logGroup('Placement'),
        streamPrefix: 'placement',
      }),
    });

    const placementMachineName = `rfpilot-${config.envName}-placement`;
    // Built from its parts rather than from the state machine construct,
    // which needs this role first.
    const placementMachineArn = this.formatArn({
      service: 'states',
      resource: 'stateMachine',
      resourceName: placementMachineName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const placementMachineRole = new iam.Role(this, 'PlacementMachineRole', {
      // Only Step Functions, only this account, and only on behalf of this
      // one state machine.
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': placementMachineArn },
        },
      }),
      description:
        'Runs the legacy-customer placement task; nothing else',
    });
    placementMachineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunThePlacementTask',
        actions: ['ecs:RunTask'],
        resources: [placementTaskDef.taskDefinitionArn],
        conditions: {
          ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
        },
      }),
    );
    placementMachineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassThePlacementTaskRoles',
        actions: ['iam:PassRole'],
        resources: [
          placementTaskDef.taskRole.roleArn,
          placementTaskDef.obtainExecutionRole().roleArn,
        ],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );
    // The `.sync` integration: Step Functions watches the task it started
    // (through one managed EventBridge rule) and stops it on timeout. These
    // are the permissions AWS documents for it, scoped to this cluster's
    // tasks and to that one rule.
    placementMachineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WatchAndStopTasksInThisCluster',
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: [
          this.formatArn({
            service: 'ecs',
            resource: 'task',
            resourceName: `${this.cluster.clusterName}/*`,
          }),
        ],
        conditions: {
          ArnEquals: { 'ecs:cluster': this.cluster.clusterArn },
        },
      }),
    );
    placementMachineRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ManagedRuleForEcsTaskEvents',
        actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
        resources: [
          this.formatArn({
            service: 'events',
            resource: 'rule',
            resourceName: 'StepFunctionsGetEventsForECSTaskRule',
          }),
        ],
      }),
    );

    // Written out as Amazon States Language so that exactly what reaches the
    // task is visible here. Do not add a `.$` path anywhere but the command.
    const runPlacementTask = new sfn.CustomState(this, 'RunPlacementTask', {
      stateJson: {
        Type: 'Task',
        Resource: `arn:${this.partition}:states:::ecs:runTask.sync`,
        Parameters: {
          Cluster: this.cluster.clusterArn,
          TaskDefinition: placementTaskDef.taskDefinitionArn,
          LaunchType: 'FARGATE',
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              Subnets: network.vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              }).subnetIds,
              SecurityGroups: [network.migrateSg.securityGroupId],
              AssignPublicIp: 'DISABLED',
            },
          },
          Overrides: {
            ContainerOverrides: [
              {
                Name: 'placement',
                'Command.$':
                  "States.Array(States.Format('--task-run={}', $.runId))",
              },
            ],
          },
        },
        // Above the task's own 30-minute ceiling; on timeout Step Functions
        // stops the task. No Retry: the placement journal is the source of
        // truth, and a failed run is retried by a person, as a new run.
        TimeoutSeconds: 2400,
        End: true,
      },
    });
    const placementMachine = new sfn.StateMachine(this, 'PlacementMachine', {
      stateMachineName: placementMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(runPlacementTask),
      role: placementMachineRole,
      timeout: cdk.Duration.minutes(45),
    });
    /* No CloudWatch logging or X-Ray on the state machine: delivering its
       log needs logs:*LogDelivery* and logs:PutResourcePolicy on "*" on the
       role, which would be the widest statement it holds. A Standard
       machine keeps each execution's history (including ECS's stop reason)
       for 90 days, the API logs it when it gives up on a run, and the task
       logs to /rfpilot/<env>/placement. */
    NagSuppressions.addResourceSuppressions(placementMachine, [
      {
        id: 'AwsSolutions-SF1',
        reason:
          'Logging ALL events needs wildcard log-delivery permissions on the state machine role, which is otherwise scoped to one task definition. Execution history is retained by Step Functions and the task has its own log group.',
      },
      {
        id: 'AwsSolutions-SF2',
        reason:
          'A single-state machine that runs one ECS task; X-Ray adds wildcard xray permissions to the role for no tracing value.',
      },
    ]);

    // The API: start an execution of that one machine, and read what became
    // of an execution it started (to log why a task never reported). No
    // ecs:* and no iam:PassRole.
    apiTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'StartPlacementExecutions',
        actions: ['states:StartExecution'],
        resources: [placementMachine.stateMachineArn],
      }),
    );
    apiTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DescribePlacementExecutions',
        actions: ['states:DescribeExecution'],
        resources: [
          this.formatArn({
            service: 'states',
            resource: 'execution',
            resourceName: `${placementMachineName}:*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // A plain identifier. Removing it switches the feature off: the
    // placement endpoints then answer 503 PLACEMENT_REQUIRES_MIGRATION_ROLE.
    apiContainer.addEnvironment(
      'PLACEMENT_STATE_MACHINE_ARN',
      placementMachine.stateMachineArn,
    );
  }
}
