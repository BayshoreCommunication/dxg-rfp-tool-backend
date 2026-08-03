import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { ENVIRONMENTS, GITHUB_REPOSITORY } from "./config";

/* Account-level CI/CD plumbing, deployed once (not per environment):
 * the ECR repository, the GitHub OIDC identity provider, and one deploy
 * role per environment. No long-lived AWS access keys exist anywhere —
 * GitHub Actions assumes these roles via OIDC, restricted to the branch
 * that owns each environment.
 */
export class CicdStack extends cdk.Stack {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "Repository", {
      repositoryName: "rfpilot-backend",
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [
        { description: "Expire untagged layers", tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: cdk.Duration.days(14) },
        { description: "Keep the last 50 releases", tagStatus: ecr.TagStatus.ANY, maxImageCount: 50 },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const provider = new iam.OpenIdConnectProvider(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    for (const config of Object.values(ENVIRONMENTS)) {
      const role = new iam.Role(this, `DeployRole-${config.envName}`, {
        roleName: `rfpilot-${config.envName}-github-deploy`,
        description: `GitHub Actions deploy role for ${config.envName} (branch ${config.deployBranch})`,
        assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            // A job bound to a GitHub environment presents an
            // environment-form sub claim instead of the branch-ref form;
            // accept exactly this environment's and this branch's claims.
            "token.actions.githubusercontent.com:sub": [
              `repo:${GITHUB_REPOSITORY}:ref:refs/heads/${config.deployBranch}`,
              `repo:${GITHUB_REPOSITORY}:environment:${config.envName}`,
            ],
          },
        }),
        maxSessionDuration: cdk.Duration.hours(2),
      });

      // Image publishing. DescribeImages backs the workflow's reuse-on-
      // promotion check (grantPullPush does not include it).
      this.repository.grantPullPush(role);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ecr:DescribeImages"],
          resources: [this.repository.repositoryArn],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
      );

      // CDK deployments happen through the bootstrap roles, never through
      // broad direct permissions on this role.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [`arn:aws:iam::${this.account}:role/cdk-*-role-${this.account}-${this.region}`],
        }),
      );

      // One-off migration task execution + deploy verification.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ecs:RunTask", "ecs:DescribeTasks", "ecs:DescribeServices", "ecs:ListTasks"],
          resources: ["*"],
          conditions: { ArnEquals: { "ecs:cluster": `arn:aws:ecs:${this.region}:${this.account}:cluster/rfpilot-${config.envName}` } },
        }),
      );
      // Task-definition actions do not support the ecs:cluster condition or
      // resource-level scoping; the workflow re-registers the migrate task
      // definition with each release's image before running it.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
          resources: ["*"],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [`arn:aws:iam::${this.account}:role/*`],
          conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["cloudformation:DescribeStacks", "logs:GetLogEvents"],
          resources: ["*"],
        }),
      );

      new cdk.CfnOutput(this, `DeployRoleArn-${config.envName}`, { value: role.roleArn });
    }

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
  }
}
