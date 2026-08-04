import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { EnvironmentConfig } from "./config";
import { NetworkStack } from "./network-stack";

/* Stateful resources: RDS PostgreSQL 16 (pgvector lives here), ElastiCache
 * Redis (transport only — deliberately no snapshots), the two S3 buckets
 * (governed private documents; app assets), KMS, and the application secret.
 *
 * This stack is deployed rarely and independently of the app stack so that
 * routine deploys can never replace a datastore.
 */
export class DataStack extends cdk.Stack {
  public readonly dataKey: kms.Key;
  public readonly documentsBucket: s3.Bucket;
  public readonly assetsBucket: s3.Bucket;
  public readonly database: rds.DatabaseInstance;
  public readonly redis: elasticache.CfnReplicationGroup;
  public readonly redisAuthSecret: secretsmanager.Secret;
  public readonly appSecret: secretsmanager.Secret;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    network: NetworkStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.dataKey = new kms.Key(this, "DataKey", {
      alias: `rfpilot-${config.envName}-data`,
      description: "RFPilot data-at-rest key (S3, RDS, Secrets Manager)",
      enableKeyRotation: true,
    });

    const bucketDefaults: s3.BucketProps = {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
        { noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
    };

    // Governed private document storage (DOCUMENT_STORAGE_*): quarantine
    // uploads, knowledge sources. Presigned PUTs inherit the bucket default
    // SSE-KMS encryption, so the application needs no code-level SSE headers.
    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      ...bucketDefaults,
      bucketName: `rfpilot-${config.envName}-documents-${this.account}`,
      // The knowledge-import flow PUTs directly from the admin browser via
      // presigned URLs, which needs CORS (the proposal-source flow uploads
      // server-side and does not). Deployed admin origins plus the local
      // dev ports; keep this list in step with wherever the admin app runs.
      cors: [{
        allowedOrigins: config.browserUploadOrigins,
        allowedMethods: [s3.HttpMethods.PUT],
        allowedHeaders: ["*"],
        maxAge: 300,
      }],
    });

    // Legacy/app asset storage (ASSET_STORAGE_*): logos, avatars, proposal
    // support documents, vendor-response documents. Also fully private —
    // formerly-public assets are served through a CDN in front of this bucket
    // (ASSET_STORAGE_PUBLIC_URL_BASE), never via object ACLs.
    this.assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      ...bucketDefaults,
      bucketName: `rfpilot-${config.envName}-assets-${this.account}`,
    });

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16,
    });

    const parameterGroup = new rds.ParameterGroup(this, "PgParams", {
      engine,
      description: "RFPilot PostgreSQL 16 - TLS required",
      parameters: { "rds.force_ssl": "1" },
    });

    // App code (config/postgres.ts) consumes a single POSTGRES_URL; the
    // generated master secret is the source from which the operator composes
    // it into the app secret at bootstrap (see README).
    this.database = new rds.DatabaseInstance(this, "Database", {
      engine,
      parameterGroup,
      instanceType: new ec2.InstanceType(config.rds.instanceClass),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.rdsSg],
      multiAz: config.rds.multiAz,
      allocatedStorage: config.rds.allocatedStorageGb,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      databaseName: "rfpilot",
      credentials: rds.Credentials.fromGeneratedSecret("rfpilot_admin", {
        encryptionKey: this.dataKey,
      }),
      backupRetention: cdk.Duration.days(config.rds.backupRetentionDays),
      deleteAutomatedBackups: false,
      deletionProtection: config.rds.deletionProtection,
      cloudwatchLogsExports: ["postgresql"],
      autoMinorVersionUpgrade: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ElastiCache Redis, cluster mode DISABLED — the application's BullMQ and
    // ioredis clients are non-cluster clients. TLS + AUTH; rediss:// URL.
    // AWS-managed Secrets Manager encryption (not the CMK): the ECS execution
    // roles in the app stack read these, and CMK grants would edit the key
    // policy here, creating a cross-stack dependency cycle.
    this.redisAuthSecret = new secretsmanager.Secret(this, "RedisAuthSecret", {
      secretName: `rfpilot/${config.envName}/redis-auth`,
      description: "ElastiCache Redis AUTH token",
      generateSecretString: {
        // Alphanumeric only: the token rides inside REDIS_URL, and a token
        // that needs no percent-encoding cannot be mis-decoded by any client.
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    const redisSubnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "RFPilot Redis subnets",
      subnetIds: network.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    this.redis = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupId: `rfpilot-${config.envName}`,
      replicationGroupDescription: "RFPilot BullMQ transport + distributed limits (reference-only payloads)",
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: config.redis.nodeType,
      numCacheClusters: 1 + config.redis.replicas,
      automaticFailoverEnabled: config.redis.replicas > 0,
      multiAzEnabled: config.redis.replicas > 0,
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [network.redisSg.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      authToken: this.redisAuthSecret.secretValue.unsafeUnwrap(),
      // Redis is transport only; the Postgres outbox is the recovery source.
      snapshotRetentionLimit: 0,
      autoMinorVersionUpgrade: true,
    });

    // Application secrets. Values are placeholders — the operator fills real
    // values via console/CLI at bootstrap; nothing secret exists in git or in
    // CloudFormation parameters. Keys mirror the backend's env contract.
    //
    // WARNING: secretObjectValue is the secret's CloudFormation-managed
    // value. Any change to this map, deployed against an env whose secret
    // has already been filled, RESETS EVERY KEY to these placeholders
    // (recover from the AWSPREVIOUS version immediately). Never redeploy
    // this stack to a live env after editing this map without re-running
    // compose-app-secrets.sh and re-filling external keys.
    this.appSecret = new secretsmanager.Secret(this, "AppSecret", {
      secretName: `rfpilot/${config.envName}/app`,
      description: "RFPilot backend application secrets (operator-managed values)",
      secretObjectValue: {
        JWT_SECRET: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        OTP_PEPPER: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        BFF_SHARED_SECRET: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        ADMIN_SIGNUP_SECRET: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        AI_SAFETY_IDENTIFIER_SECRET: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        TELEMETRY_PSEUDONYM_KEY: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        OPENAI_API_KEY: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        GOOGLE_CLIENT_ID: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        MONGODB_URL: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        POSTGRES_URL: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        POSTGRES_MIGRATION_URL: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        REDIS_URL: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        SMTP_HOST: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        SMTP_PORT: cdk.SecretValue.unsafePlainText("587"),
        SMTP_MAIL: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        // SES SMTP credentials (IAM-derived): username is the access key id.
        SMTP_USER: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        SMTP_PASSWORD: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
      },
    });

    // CDN in front of app assets (formerly public-read Spaces objects). Lives
    // in this stack because its origin-access-control statement is written
    // into the assets bucket's policy, which this stack owns.
    const assetsCdn = new cloudfront.Distribution(this, "AssetsCdn", {
      comment: `rfpilot-${config.envName} app assets`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    new cdk.CfnOutput(this, "AssetsCdnDomain", {
      value: assetsCdn.distributionDomainName,
      description: "Set ASSET_STORAGE_PUBLIC_URL_BASE to https://<this domain>",
    });

    // The wildcard-scoped KMS condition for CloudFront OAC is a known,
    // deliberate first-deploy tradeoff; scoping it down to the real
    // distribution ARN is a documented post-first-deploy hardening step in
    // the README. Acknowledged so --strict synth stays warning-clean.
    cdk.Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac",
      "Post-first-deploy hardening step documented in deploy/aws/README.md",
    );
    new cdk.CfnOutput(this, "RedisPrimaryEndpoint", {
      value: `${this.redis.attrPrimaryEndPointAddress}:${this.redis.attrPrimaryEndPointPort}`,
      description: "Compose into REDIS_URL as rediss://:<auth-token>@<endpoint>",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: this.database.instanceEndpoint.socketAddress,
      description: "Compose into POSTGRES_URL / POSTGRES_MIGRATION_URL",
    });
    // Consumed by scripts/compose-app-secrets.sh so an operator can fill the
    // composed connection strings without ever seeing or typing the values.
    new cdk.CfnOutput(this, "DatabaseSecretArn", { value: this.database.secret!.secretArn });
    new cdk.CfnOutput(this, "RedisAuthSecretArn", { value: this.redisAuthSecret.secretArn });
    new cdk.CfnOutput(this, "AppSecretArn", { value: this.appSecret.secretArn });
  }
}
