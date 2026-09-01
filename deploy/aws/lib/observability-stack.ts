import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { EnvironmentConfig } from "./config";
import { AppStack } from "./app-stack";
import { DataStack } from "./data-stack";

/* Alarms and the alert topic. The worker and dispatcher expose no health
 * port, so their health signals are: ECS running-task count, task restarts
 * (via deployment/task metrics), and log patterns. Queue-backlog and
 * outbox-age custom metrics (which need a scheduled probe against Postgres)
 * are a documented follow-up in the README.
 */
export class ObservabilityStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    app: AppStack,
    data: DataStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const topic = new sns.Topic(this, "Alerts", {
      topicName: `rfpilot-${config.envName}-alerts`,
      enforceSSL: true,
    });
    const alertEmail = this.node.tryGetContext("alertEmail") as string | undefined;
    if (alertEmail) {
      topic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    }

    const alert = (alarm: cloudwatch.Alarm): void => {
      alarm.addAlarmAction(new actions.SnsAction(topic));
      alarm.addOkAction(new actions.SnsAction(topic));
    };

    /* ALB: 5xx from the app, and no healthy API targets. */
    alert(
      new cloudwatch.Alarm(this, "Api5xx", {
        alarmName: `rfpilot-${config.envName}-api-5xx`,
        metric: app.alb.metrics.httpCodeTarget(elbHttpCode5xx(), {
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /* Service health: running tasks below desired for 5 minutes. Covers the
     * worker and dispatcher, which cannot be probed over the network.
     *
     * RunningTaskCount lives ONLY in the ECS/ContainerInsights namespace, so
     * when Container Insights is off (config.containerInsights === false, the
     * production default — it costs ~$47/month) the alarm falls back to the
     * standard AWS/ECS CPUUtilization metric with an impossible threshold:
     * utilisation is never below zero, so the alarm can only be driven by
     * MISSING data, and ECS publishes no service datapoints when no task is
     * running. That detects "this service has stopped" without Container
     * Insights.
     *
     * The fallback is deliberately NOT equivalent: it detects zero running
     * tasks, not "fewer running than desired". Every service here has a
     * desired count of 1, so the two coincide today — but if worker ever
     * runs a steady-state count above 1 (workerMaxCount allows scaling to
     * 4), partial degradation would go unalarmed. Turn Container Insights
     * back on before relying on multi-task services. */
    for (const [name, service, desired] of [
      ["api", app.apiService, 1],
      ["cron", app.cronService, config.ecs.cronDesiredCount],
      ["worker", app.workerService, 1],
      ["dispatcher", app.dispatcherService, 1],
      ["clamav", app.clamavService, config.ecs.clamavDesiredCount],
    ] as const) {
      // Skip alarms for services scaled to zero — there are no tasks to
      // monitor, and the missing-data fallback would fire immediately.
      if (desired === 0) continue;
      alert(
        new cloudwatch.Alarm(this, `${name}TasksLow`, {
          alarmName: `rfpilot-${config.envName}-${name}-tasks-low`,
          metric: config.containerInsights
            ? new cloudwatch.Metric({
                namespace: "ECS/ContainerInsights",
                metricName: "RunningTaskCount",
                dimensionsMap: { ClusterName: app.cluster.clusterName, ServiceName: service.serviceName },
                period: cdk.Duration.minutes(1),
                statistic: "Minimum",
              })
            : service.metricCpuUtilization({ period: cdk.Duration.minutes(1), statistic: "Minimum" }),
          threshold: config.containerInsights ? desired : 0,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 5,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        }),
      );
      alert(
        new cloudwatch.Alarm(this, `${name}Cpu`, {
          alarmName: `rfpilot-${config.envName}-${name}-cpu-high`,
          metric: service.metricCpuUtilization({ period: cdk.Duration.minutes(5) }),
          threshold: 85,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
      alert(
        new cloudwatch.Alarm(this, `${name}Memory`, {
          alarmName: `rfpilot-${config.envName}-${name}-memory-high`,
          metric: service.metricMemoryUtilization({ period: cdk.Duration.minutes(5) }),
          threshold: 85,
          evaluationPeriods: 3,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    /* RDS. */
    alert(
      new cloudwatch.Alarm(this, "RdsCpu", {
        alarmName: `rfpilot-${config.envName}-rds-cpu-high`,
        metric: data.database.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alert(
      new cloudwatch.Alarm(this, "RdsStorage", {
        alarmName: `rfpilot-${config.envName}-rds-storage-low`,
        metric: data.database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }),
        threshold: 5 * 1024 * 1024 * 1024,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alert(
      new cloudwatch.Alarm(this, "RdsConnections", {
        alarmName: `rfpilot-${config.envName}-rds-connections-high`,
        metric: data.database.metricDatabaseConnections({ period: cdk.Duration.minutes(5) }),
        // 3 services + migrations at POSTGRES_POOL_MAX=10 each sit near 30–40;
        // sustained readings far above that mean a pool leak or task storm.
        threshold: 80,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /* ElastiCache. */
    const redisMetric = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/ElastiCache",
        metricName,
        dimensionsMap: { ReplicationGroupId: data.redis.replicationGroupId ?? `rfpilot-${config.envName}` },
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      });
    alert(
      new cloudwatch.Alarm(this, "RedisCpu", {
        alarmName: `rfpilot-${config.envName}-redis-cpu-high`,
        metric: redisMetric("EngineCPUUtilization"),
        threshold: 80,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    alert(
      new cloudwatch.Alarm(this, "RedisMemory", {
        alarmName: `rfpilot-${config.envName}-redis-memory-high`,
        metric: redisMetric("DatabaseMemoryUsagePercentage"),
        threshold: 80,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
  }
}

/* elbv2's typed helper for target 5xx codes. */
import { HttpCodeTarget } from "aws-cdk-lib/aws-elasticloadbalancingv2";
const elbHttpCode5xx = (): HttpCodeTarget => HttpCodeTarget.TARGET_5XX_COUNT;
