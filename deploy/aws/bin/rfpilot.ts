#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";
import { ENVIRONMENTS } from "../lib/config";
import { NetworkStack } from "../lib/network-stack";
import { DataStack } from "../lib/data-stack";
import { AppStack } from "../lib/app-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { CicdStack } from "../lib/cicd-stack";

/* Stack layout (per environment, plus one shared CI/CD stack):
 *   Rfpilot-Cicd                      ECR + GitHub OIDC deploy roles
 *   Rfpilot-<env>-Network             VPC, subnets, security groups
 *   Rfpilot-<env>-Data                RDS, Redis, S3, KMS, secrets (stateful)
 *   Rfpilot-<env>-App                 ECS services, ALB, WAF, CDN
 *   Rfpilot-<env>-Observability       alarms + alert topic
 *
 * Account and region come from the standard CDK environment variables
 * (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION); region defaults to us-east-2.
 * Run with `-c nag=true` to evaluate cdk-nag AwsSolutions checks.
 */
const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
};

const cicd = new CicdStack(app, "Rfpilot-Cicd", { env });

/* cdk-nag suppressions, each with its rationale. Anything not listed here is
 * a live finding that must be fixed, not suppressed. */
const suppress = (stack: cdk.Stack, rules: Array<{ id: string; reason: string }>): void =>
  NagSuppressions.addStackSuppressions(stack, rules, true);

suppress(cicd, [
  { id: "AwsSolutions-IAM5", reason: "grantPullPush/AssumeRole on cdk-* bootstrap roles and ecr:GetAuthorizationToken are inherently wildcard-scoped; deploy roles are branch-locked via OIDC subject." },
]);

for (const config of Object.values(ENVIRONMENTS)) {
  const prefix = `Rfpilot-${config.envName}`;
  const network = new NetworkStack(app, `${prefix}-Network`, config, { env });
  const data = new DataStack(app, `${prefix}-Data`, config, network, {
    env,
    terminationProtection: config.envName === "production",
  });
  const application = new AppStack(app, `${prefix}-App`, config, network, data, { env });
  new ObservabilityStack(app, `${prefix}-Observability`, config, application, data, { env });

  suppress(network, [
    { id: "AwsSolutions-EC23", reason: "The ALB security group is deliberately internet-facing on 80/443; every other group is source-scoped to specific security groups." },
  ]);
  suppress(data, [
    { id: "AwsSolutions-SMG4", reason: "App secret values are operator-managed (Atlas/OpenAI/SMTP credentials issued elsewhere); rotation is a documented runbook procedure, not Lambda-automated." },
    { id: "AwsSolutions-S1", reason: "S3 server access logging deferred; CloudTrail covers management events and the buckets are private, KMS-encrypted, TLS-only." },
    { id: "AwsSolutions-RDS11", reason: "Non-default ports add no security over security-group scoping; access is limited to app task security groups." },
    { id: "AwsSolutions-AEC5", reason: "Same rationale as RDS11 — Redis is reachable only from app task security groups, with TLS and AUTH required." },
    { id: "AwsSolutions-CFR1", reason: "Asset CDN serves public brand assets; geo restriction is not a requirement." },
    { id: "AwsSolutions-CFR2", reason: "The CDN fronts read-only public static assets from a private bucket; the application's WAF sits on the ALB." },
    { id: "AwsSolutions-CFR3", reason: "CDN access logging deferred alongside S3 access logging." },
    { id: "AwsSolutions-CFR4", reason: "Distribution uses the default CloudFront certificate until a custom asset domain exists; minimumProtocolVersion is set for when one is attached." },
    ...(config.envName === "staging"
      ? [
          { id: "AwsSolutions-RDS3", reason: "Staging runs single-AZ by design; production is Multi-AZ." },
          { id: "AwsSolutions-RDS10", reason: "Staging allows deletion by design; production has deletion protection and termination protection." },
          { id: "AwsSolutions-AEC4", reason: "Staging Redis runs a single node by design; production has a replica with automatic failover." },
        ]
      : []),
  ]);
  suppress(application, [
    { id: "AwsSolutions-IAM5", reason: "Wildcards are grant-generated object-level S3/KMS actions (bucket/*) from grantReadWrite on the task roles; buckets themselves are least-privilege per service." },
    { id: "AwsSolutions-ECS2", reason: "Plain environment entries are non-secret configuration (flags, bucket names, hosts); every credential is injected via Secrets Manager ECS secrets." },
    { id: "AwsSolutions-EC23", reason: "Only the ALB accepts internet traffic; service security groups are source-scoped." },
    { id: "AwsSolutions-S1", reason: "The ALB access-log bucket cannot log to itself; it is private, SSE-S3 (ELB requirement), TLS-only, 90-day expiry." },
    { id: "AwsSolutions-ELB2", reason: "ALB access logs ARE enabled (logAccessLogs); rule fires on the log bucket's own delivery policy ordering." },
  ]);
}

if (app.node.tryGetContext("nag") === "true") {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
}

app.synth();
