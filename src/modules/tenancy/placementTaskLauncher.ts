import { ECSClient, RunTaskCommand, type RunTaskCommandInput } from "@aws-sdk/client-ecs";
import type { PlacementTaskLauncher } from "./placementTasks";

// Starts scripts/placeLegacyCustomer.js as a one-off ECS task on the migrate task definition
// (owner's decision, 2026-11-17). The API's task role may run that one task definition and pass
// its two roles, and nothing else (deploy/aws/lib/app-stack.ts).
//
// What crosses into the task is fixed here: the command is a constant list with the run id as
// its last element, never a shell string, and the run id must look like one this module's own
// journal issues. The customer, the target organization, the role and the staff member are read
// by the task from the journal entry the API wrote, so no request value reaches the command.

export type PlacementTaskConfig = {
  cluster: string; taskDefinition: string; subnets: string[]; securityGroup: string; container: string; region?: string;
};

const RUN_ID = /^placement-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-f0-9]{8}$/;
const CLUSTER = /^(arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:cluster\/)?[A-Za-z0-9_-]{1,255}$/;
// Only the migrate task definition: its family, or one revision of it.
const TASK_DEFINITION = /^(?:arn:aws[a-z-]*:ecs:([a-z0-9-]+):\d{12}:task-definition\/)?rfpilot-[a-z0-9]+-migrate(?::\d+)?$/;
const SUBNET = /^subnet-[0-9a-f]{8,17}$/;
const SECURITY_GROUP = /^sg-[0-9a-f]{8,17}$/;
const CONTAINER = /^[A-Za-z0-9_-]{1,255}$/;

export class PlacementTaskConfigError extends Error {}

const ENV_NAMES = ["PLACEMENT_TASK_CLUSTER", "PLACEMENT_TASK_DEFINITION", "PLACEMENT_TASK_SUBNETS", "PLACEMENT_TASK_SECURITY_GROUP", "PLACEMENT_TASK_CONTAINER"] as const;

// null when this process isn't set up to start placement tasks at all (local, rehearsal).
// A partial or malformed setting is an error, never a silent fallback.
export const placementTaskConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PlacementTaskConfig | null => {
  const value = (name: (typeof ENV_NAMES)[number]) => env[name]?.trim() ?? "";
  if (ENV_NAMES.every((name) => !value(name))) return null;
  const missing = ENV_NAMES.filter((name) => !value(name));
  if (missing.length) throw new PlacementTaskConfigError(`Placement task settings are incomplete: ${missing.join(", ")}`);
  const config: PlacementTaskConfig = {
    cluster: value("PLACEMENT_TASK_CLUSTER"), taskDefinition: value("PLACEMENT_TASK_DEFINITION"),
    subnets: value("PLACEMENT_TASK_SUBNETS").split(",").map((subnet) => subnet.trim()).filter(Boolean),
    securityGroup: value("PLACEMENT_TASK_SECURITY_GROUP"), container: value("PLACEMENT_TASK_CONTAINER"),
  };
  assertPlacementTaskConfig(config);
  return { ...config, region: TASK_DEFINITION.exec(config.taskDefinition)?.[1] };
};

export const assertPlacementTaskConfig = (config: PlacementTaskConfig) => {
  const bad = (what: string) => { throw new PlacementTaskConfigError(`Placement task settings are invalid: ${what}`); };
  if (!CLUSTER.test(config.cluster)) bad("cluster");
  if (!TASK_DEFINITION.test(config.taskDefinition)) bad("task definition (must be the migrate task definition)");
  if (config.subnets.length === 0 || config.subnets.length > 16 || !config.subnets.every((subnet) => SUBNET.test(subnet))) bad("subnets");
  if (!SECURITY_GROUP.test(config.securityGroup)) bad("security group");
  if (!CONTAINER.test(config.container)) bad("container");
};

// The only command the API ever starts.
export const placementTaskCommand = (runId: string): string[] => {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new PlacementTaskConfigError("Refusing to start a task for a malformed run id");
  return ["node", "dist/scripts/placeLegacyCustomer.js", `--task-run=${runId}`];
};

export const buildRunTaskInput = (config: PlacementTaskConfig, input: { runId: string; launchToken: string }): RunTaskCommandInput => {
  assertPlacementTaskConfig(config);
  if (!/^[a-f0-9]{64}$/.test(input.launchToken)) throw new PlacementTaskConfigError("Refusing to start a task with a malformed launch token");
  return {
    cluster: config.cluster,
    taskDefinition: config.taskDefinition,
    launchType: "FARGATE",
    count: 1,
    // ECS starts nothing new for a token it has already seen.
    clientToken: input.launchToken,
    startedBy: "rfpilot-api-placement",
    networkConfiguration: { awsvpcConfiguration: { subnets: config.subnets, securityGroups: [config.securityGroup], assignPublicIp: "DISABLED" } },
    overrides: {
      containerOverrides: [{
        name: config.container,
        command: placementTaskCommand(input.runId),
        // The cutover runbook's lock timeout for work on a live product: wait 15 s for a lock,
        // then fail with nothing moved instead of queueing customers' requests behind it.
        environment: [{ name: "PGOPTIONS", value: "-c lock_timeout=15000" }],
      }],
    },
  };
};

export const createEcsPlacementTaskLauncher = (
  config: PlacementTaskConfig,
  client: Pick<ECSClient, "send"> = new ECSClient({ ...(config.region ? { region: config.region } : {}), maxAttempts: 2 }),
): PlacementTaskLauncher => ({
  async launch(input) {
    const result = await client.send(new RunTaskCommand(buildRunTaskInput(config, input)));
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const failure = result.failures?.[0];
      throw new Error(`ECS did not start the task${failure ? `: ${failure.reason ?? "unknown"}${failure.detail ? ` (${failure.detail})` : ""}` : ""}`);
    }
    return { taskArn };
  },
});
