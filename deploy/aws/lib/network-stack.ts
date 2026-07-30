import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { EnvironmentConfig } from "./config";

/* VPC, subnets, NAT, VPC endpoints, and the security groups that encode the
 * network policy:
 *   internet -> ALB only; ALB -> API :8000 only; {API, worker} -> ClamAV :3310;
 *   {API, worker, dispatcher, migrate} -> RDS :5432 and Redis :6379;
 *   tasks have no public IPs; all other egress leaves via NAT.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly apiSg: ec2.SecurityGroup;
  public readonly workerSg: ec2.SecurityGroup;
  public readonly dispatcherSg: ec2.SecurityGroup;
  public readonly migrateSg: ec2.SecurityGroup;
  public readonly clamavSg: ec2.SecurityGroup;
  public readonly rdsSg: ec2.SecurityGroup;
  public readonly redisSg: ec2.SecurityGroup;

  /* Pinned AZs keep synth deterministic and credential-free (no
   * DescribeAvailabilityZones context lookup at synth time). */
  public get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: 2,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.vpc.addFlowLog("FlowLog", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    // Keep S3/ECR/Secrets/Logs traffic off the NAT gateway.
    this.vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    this.vpc.addInterfaceEndpoint("EcrApiEndpoint", { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint("EcrDkrEndpoint", { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addInterfaceEndpoint("LogsEndpoint", { service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
    this.vpc.addInterfaceEndpoint("SecretsEndpoint", { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER });

    const sg = (name: string, description: string): ec2.SecurityGroup =>
      new ec2.SecurityGroup(this, name, { vpc: this.vpc, description, allowAllOutbound: true });

    this.albSg = sg("AlbSg", "RFPilot ALB");
    this.apiSg = sg("ApiSg", "RFPilot API tasks");
    this.workerSg = sg("WorkerSg", "RFPilot durable worker tasks");
    this.dispatcherSg = sg("DispatcherSg", "RFPilot dispatcher tasks");
    this.migrateSg = sg("MigrateSg", "RFPilot one-off migration tasks");
    this.clamavSg = sg("ClamavSg", "RFPilot ClamAV service");

    // Data-store security groups deliberately allow no outbound; they only
    // ever answer inbound connections from application tasks.
    this.rdsSg = new ec2.SecurityGroup(this, "RdsSg", {
      vpc: this.vpc,
      description: "RFPilot RDS PostgreSQL",
      allowAllOutbound: false,
    });
    this.redisSg = new ec2.SecurityGroup(this, "RedisSg", {
      vpc: this.vpc,
      description: "RFPilot ElastiCache Redis",
      allowAllOutbound: false,
    });

    this.apiSg.addIngressRule(this.albSg, ec2.Port.tcp(8000), "ALB to API");
    this.clamavSg.addIngressRule(this.apiSg, ec2.Port.tcp(3310), "API scans (vendor uploads, manual rescan)");
    this.clamavSg.addIngressRule(this.workerSg, ec2.Port.tcp(3310), "Worker scans (source security jobs)");

    for (const [name, appSg] of [
      ["api", this.apiSg],
      ["worker", this.workerSg],
      ["dispatcher", this.dispatcherSg],
      ["migrate", this.migrateSg],
    ] as const) {
      this.rdsSg.addIngressRule(appSg, ec2.Port.tcp(5432), `${name} to PostgreSQL`);
      this.redisSg.addIngressRule(appSg, ec2.Port.tcp(6379), `${name} to Redis`);
    }
  }
}
