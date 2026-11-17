import { DescribeExecutionCommand, SFNClient, StartExecutionCommand, type StartExecutionCommandInput } from "@aws-sdk/client-sfn";
import type { PlacementTaskLauncher } from "./placementTasks";

// Starts the placement task by starting an execution of one Step Functions state machine
// (owner's decision, 2026-11-17, after security review). The API's task role may start and
// describe executions of that machine, and nothing else: no ecs:RunTask and no iam:PassRole.
//
// Why not ecs:RunTask from the API: IAM cannot restrict RunTask's overrides, so permission to
// run a task that holds the migration role is permission to run any command with it. The state
// machine (deploy/aws/lib/app-stack.ts) fixes the cluster, task definition, network, container
// and command in its definition, and reads one field of the execution input, the run id, into
// one argument. The task's entry point (scripts/runPlacementTask.ts) accepts only that argument.
//
// So the only thing this module can send is a run id. The customer, the target organization,
// the role and the staff member are read by the task from the journal entry the API wrote, and
// checked again there.

export type PlacementTaskConfig = { stateMachineArn: string; region: string };

export const PLACEMENT_RUN_ID = /^placement-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-f0-9]{8}$/;
// Only the placement state machine of this deployment.
const STATE_MACHINE = /^arn:aws[a-z-]*:states:([a-z0-9-]+):\d{12}:stateMachine:rfpilot-[a-z0-9]+-placement$/;
const LAUNCH_TOKEN = /^[a-f0-9]{64}$/;

export class PlacementTaskConfigError extends Error {}

export const PLACEMENT_STATE_MACHINE_ENV = "PLACEMENT_STATE_MACHINE_ARN";

// null when this process isn't set up to start placement tasks (local, rehearsal, or the feature
// switched off). A malformed setting is an error, never a silent fallback.
export const placementTaskConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PlacementTaskConfig | null => {
  const stateMachineArn = env[PLACEMENT_STATE_MACHINE_ENV]?.trim() ?? "";
  if (!stateMachineArn) return null;
  const match = STATE_MACHINE.exec(stateMachineArn);
  if (!match) throw new PlacementTaskConfigError(`${PLACEMENT_STATE_MACHINE_ENV} is not the placement state machine's ARN`);
  return { stateMachineArn, region: match[1] };
};

// The execution's whole input. Nothing else from a request can reach the task.
export const buildStartExecutionInput = (config: PlacementTaskConfig, input: { runId: string; launchToken: string }): StartExecutionCommandInput => {
  if (!STATE_MACHINE.test(config.stateMachineArn)) throw new PlacementTaskConfigError("Refusing to start anything but the placement state machine");
  if (typeof input.runId !== "string" || !PLACEMENT_RUN_ID.test(input.runId)) throw new PlacementTaskConfigError("Refusing to start a task for a malformed run id");
  if (typeof input.launchToken !== "string" || !LAUNCH_TOKEN.test(input.launchToken)) throw new PlacementTaskConfigError("Refusing to start a task with a malformed launch token");
  return {
    stateMachineArn: config.stateMachineArn,
    // One execution per attempt: Step Functions refuses a second start with the same name.
    // (The run id itself can't be the name: execution names may not contain ":".)
    name: input.launchToken,
    input: JSON.stringify({ runId: input.runId }),
  };
};

const executionArn = (config: PlacementTaskConfig, launchToken: string) => {
  if (!LAUNCH_TOKEN.test(launchToken)) throw new PlacementTaskConfigError("Malformed launch token");
  return config.stateMachineArn.replace(":stateMachine:", ":execution:") + `:${launchToken}`;
};

type SfnLike = Pick<SFNClient, "send">;
const defaultClient = (config: PlacementTaskConfig): SfnLike =>
  // Bounded: a request that hangs must not hold the admin's request open.
  new SFNClient({ region: config.region, maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 8_000 } });

export const createPlacementTaskLauncher = (config: PlacementTaskConfig, client: SfnLike = defaultClient(config)): PlacementTaskLauncher => ({
  async launch(input) {
    try {
      await client.send(new StartExecutionCommand(buildStartExecutionInput(config, input)));
    } catch (error) {
      // The same attempt was already started (a retry after a timeout): that is what was asked.
      if ((error as { name?: string })?.name === "ExecutionAlreadyExists") return;
      throw error;
    }
  },
  async describe(input) {
    const execution = await client.send(new DescribeExecutionCommand({ executionArn: executionArn(config, input.launchToken) }));
    return {
      status: execution.status,
      ...(execution.error ? { error: execution.error } : {}),
      ...(execution.cause ? { cause: execution.cause.slice(0, 2000) } : {}),
    };
  },
});
