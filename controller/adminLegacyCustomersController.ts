import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { Pool } from "pg";
import type { AuthRequest } from "../middleware/auth";
import {
  assertRollbackAllowed,
  listTargetOrganizations,
  listUnplacedLegacyCustomers,
  newPlacementRunId,
  placeLegacyCustomer,
  PlacementError,
  rollbackPlacement,
  validatePlacementRequest,
  type NewOrganizationDetails,
  type PlacementActor,
  type PlacementTarget,
} from "../src/modules/tenancy/legacyCustomerPlacement";
import { createEcsPlacementTaskLauncher, placementTaskConfigFromEnv, PlacementTaskConfigError } from "../src/modules/tenancy/placementTaskLauncher";
import { mongoPlacementTaskStore } from "../src/modules/tenancy/placementTaskStore";
import { createPlacementTaskService, placementRunView, placementTaskPolicyFromEnv, type PlacementTaskLauncher, type PlacementTaskService } from "../src/modules/tenancy/placementTasks";

// ORG-110 admin API. Moving Postgres rows between organizations needs the table-owner (migration)
// role, and the public API deliberately runs without it. So there are two ways a placement runs:
//
// - "direct": this process holds POSTGRES_MIGRATION_URL (local stack, rehearsal, integration
//   suite) or the Postgres foundation is off. The placement runs inside the request, as before.
// - "task": production. This process has no migration role but is told which one-off task to
//   start (PLACEMENT_TASK_*). The request is validated and journaled here, the move runs in a
//   task on the migrate task definition, and the client polls GET /placements/:runId
//   (owner's decision, 2026-11-17; src/modules/tenancy/placementTasks.ts).
//
// With neither, placement is refused with 503 rather than moving MongoDB alone.
let migrationPool: Pool | null | undefined;
let taskService: PlacementTaskService | null | undefined;
let launcherOverride: PlacementTaskLauncher | undefined;

type PlacementMode = { kind: "direct"; pool: Pool | null } | { kind: "task"; tasks: PlacementTaskService };
const taskServiceWith = (launcher: PlacementTaskLauncher) => createPlacementTaskService({
  store: mongoPlacementTaskStore, launcher, validatePlacement: validatePlacementRequest, assertRollbackAllowed,
  newRunId: newPlacementRunId, policy: placementTaskPolicyFromEnv(),
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});
const placementMode = (): PlacementMode => {
  if (process.env.POSTGRES_FOUNDATION_ENABLED !== "true") return { kind: "direct", pool: null };
  const connectionString = process.env.POSTGRES_MIGRATION_URL?.trim();
  if (connectionString) {
    migrationPool ??= new Pool({ connectionString, max: 2, ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined });
    return { kind: "direct", pool: migrationPool };
  }
  if (taskService === undefined) {
    try {
      const config = placementTaskConfigFromEnv();
      taskService = launcherOverride ? taskServiceWith(launcherOverride) : config ? taskServiceWith(createEcsPlacementTaskLauncher(config)) : null;
    } catch (error) {
      if (!(error instanceof PlacementTaskConfigError)) throw error;
      console.error("Legacy customer placement:", error.message);
      throw new PlacementError("PLACEMENT_TASK_MISCONFIGURED", "This server's placement task settings are wrong, so placement is unavailable.", 503);
    }
  }
  if (!taskService) {
    throw new PlacementError("PLACEMENT_REQUIRES_MIGRATION_ROLE", "Placement needs the Postgres migration role, which this server isn't configured with.", 503);
  }
  return { kind: "task", tasks: taskService };
};
export const closePlacementPool = async () => {
  await migrationPool?.end();
  migrationPool = undefined;
};
// Tests only: replaces the ECS launcher (and forgets the service built from the environment).
export const setPlacementTaskLauncherForTests = (launcher: PlacementTaskLauncher | undefined) => {
  launcherOverride = launcher;
  taskService = undefined;
};

const actorFrom = (req: AuthRequest): PlacementActor => ({
  adminUserId: req.user!.userId,
  adminOrganizationId: req.user!.organizationId!,
  correlationId: (req as AuthRequest & { correlationId?: string }).correlationId ?? randomUUID(),
});
const idempotencyKey = (req: AuthRequest) => {
  const header = req.headers["idempotency-key"];
  return typeof header === "string" ? header.trim() : undefined;
};
const body = (req: AuthRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

const fail = (res: Response, error: unknown) => {
  if (error instanceof PlacementError) {
    if (error.status === 429) res.setHeader("Retry-After", "30");
    res.status(error.status).json({ success: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  console.error("Legacy customer placement error:", error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, code: "PLACEMENT_INTERNAL_ERROR", message: "The placement request could not be completed." });
};

const targetFrom = (input: Record<string, unknown>): PlacementTarget => {
  if (input.target === "new") {
    const organization = (typeof input.organization === "object" && input.organization !== null ? input.organization : {}) as Record<string, unknown>;
    return { kind: "new", organization: organization as unknown as NewOrganizationDetails };
  }
  if (input.target === "existing") {
    return { kind: "existing", organizationId: String(input.organizationId ?? ""), role: String(input.role ?? ""), teamId: (input.teamId as string | null | undefined) ?? null };
  }
  throw new PlacementError("TARGET_REQUIRED", "Choose a new or an existing organization.", 400);
};

export const listLegacyCustomers = async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ success: true, data: { customers: await listUnplacedLegacyCustomers() } });
  } catch (error) { fail(res, error); }
};

export const listPlacementTargets = async (req: AuthRequest, res: Response) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({ success: true, data: { organizations: await listTargetOrganizations({ q }) } });
  } catch (error) { fail(res, error); }
};

export const placeCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const userId = String(req.params.userId ?? "");
    const target = targetFrom(body(req));
    const mode = placementMode();
    if (mode.kind === "task") {
      const { run, replayed } = await mode.tasks.requestPlacement({ userId, target, actor: actorFrom(req), idempotencyKey: idempotencyKey(req) });
      res.status(202).json({ success: true, data: { placement: run, replayed } });
      return;
    }
    const placement = await placeLegacyCustomer({ userId, target, actor: actorFrom(req), pool: mode.pool });
    res.status(201).json({ success: true, data: { placement } });
  } catch (error) { fail(res, error); }
};

export const getPlacementRun = async (req: AuthRequest, res: Response) => {
  try {
    const runId = String(req.params.runId ?? "");
    // Reading is also when a one-off task that never started or stopped reporting is given up
    // on, so only the mode that starts tasks does that; the journal is read the same way in both.
    let tasks: PlacementTaskService | null = null;
    try {
      const mode = placementMode();
      if (mode.kind === "task") tasks = mode.tasks;
    } catch (error) {
      if (!(error instanceof PlacementError)) throw error;
    }
    const entry = tasks ? null : await mongoPlacementTaskStore.find(runId);
    const placement = tasks ? await tasks.getRun(runId) : entry ? placementRunView(entry) : null;
    if (!placement) throw new PlacementError("PLACEMENT_NOT_FOUND", "Placement run not found.", 404);
    res.json({ success: true, data: { placement } });
  } catch (error) { fail(res, error); }
};

export const rollbackPlacementRun = async (req: AuthRequest, res: Response) => {
  try {
    const runId = String(req.params.runId ?? "");
    const mode = placementMode();
    if (mode.kind === "task") {
      const { run, replayed } = await mode.tasks.requestRollback({ runId, actor: actorFrom(req), idempotencyKey: idempotencyKey(req) });
      res.status(202).json({ success: true, data: { placement: run, replayed } });
      return;
    }
    const result = await rollbackPlacement({ runId, actor: actorFrom(req), pool: mode.pool });
    res.json({ success: true, data: { rollback: result } });
  } catch (error) { fail(res, error); }
};
