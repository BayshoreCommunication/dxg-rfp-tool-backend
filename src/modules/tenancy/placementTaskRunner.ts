import type { Pool } from "pg";
import { placeLegacyCustomer, PlacementError, rollbackPlacement, type PlacementActor, type PlacementJournalEntry } from "./legacyCustomerPlacement";
import { claimQueuedTask, mongoPlacementTaskStore, recordTaskHeartbeat } from "./placementTaskStore";

// The task's side of a queued run (scripts/placeLegacyCustomer.js --task-run=<runId>): claim the
// request the API journaled, run the same placement or rollback the synchronous path runs, and
// write the outcome where GET /placements/:runId reads it.
//
// While it works it writes a heartbeat. The API gives up on a task whose heartbeat is three
// minutes old; this side stops itself after one minute without a successful heartbeat, or as
// soon as a heartbeat shows the API has given up, so the two never both believe they own a run.

export type PlacementTaskOutcome =
  | { ran: false; reason: "NOT_QUEUED" }
  | { ran: true; ok: true; operation: "placement" | "rollback"; result: unknown }
  | { ran: true; ok: false; operation: "placement" | "rollback"; code: string; message: string; details?: Record<string, unknown> };

const isObjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);

export const runPlacementTask = async (input: {
  runId: string; pool: Pool | null;
  heartbeatMs?: number; leaseMs?: number; maxRunMs?: number;
  // Called when this task must stop at once. The script exits the process, which rolls back the
  // open Postgres transaction and aborts the MongoDB one.
  onLeaseLost: (reason: string) => void;
}): Promise<PlacementTaskOutcome> => {
  const claimed: PlacementJournalEntry | null = await claimQueuedTask(input.runId);
  const task = claimed?.task;
  // Not queued: never requested, already taken by another task, or given up on by the API.
  if (!claimed || !task) return { ran: false, reason: "NOT_QUEUED" };

  const heartbeatMs = input.heartbeatMs ?? 15_000;
  const leaseMs = input.leaseMs ?? 60_000;
  const startedAt = Date.now();
  let lastBeat = startedAt;
  let beating = false;
  const timer = setInterval(() => {
    if (Date.now() - startedAt > (input.maxRunMs ?? 30 * 60_000)) return input.onLeaseLost("the task ran past its time limit");
    if (Date.now() - lastBeat > leaseMs) return input.onLeaseLost("no heartbeat could be written within the lease");
    if (beating) return;
    beating = true;
    recordTaskHeartbeat(input.runId, task.requestedAt)
      .then((owned) => (owned ? void (lastBeat = Date.now()) : input.onLeaseLost("the API gave up on this task")))
      .catch(() => undefined)
      .finally(() => { beating = false; });
  }, heartbeatMs);
  timer.unref();

  const finish = (change: { status: "succeeded" | "failed"; code?: string; message?: string; details?: Record<string, unknown> }) =>
    mongoPlacementTaskStore.update(input.runId, { taskRequestedAt: task.requestedAt, taskStatus: "running" }, { release: true, task: { ...change, finishedAt: new Date() } });

  try {
    // The staff member who asked, as the API recorded them: the audit events name this actor.
    if (!isObjectId(task.adminUserId) || !isObjectId(task.adminOrganizationId)) throw new PlacementError("PLACEMENT_REQUEST_INVALID", "The queued request names no staff member.", 400);
    const actor: PlacementActor = { adminUserId: task.adminUserId, adminOrganizationId: task.adminOrganizationId, correlationId: task.correlationId };
    let result: unknown;
    if (task.operation === "placement") {
      if (!claimed.request?.target) throw new PlacementError("PLACEMENT_REQUEST_INVALID", "The queued request names no target.", 400);
      result = await placeLegacyCustomer({ userId: claimed.userId, target: claimed.request.target, actor, pool: input.pool, adoptQueuedRunId: input.runId });
    } else {
      result = await rollbackPlacement({ runId: input.runId, actor, pool: input.pool, adoptQueued: true });
    }
    await finish({ status: "succeeded" });
    return { ran: true, ok: true, operation: task.operation, result };
  } catch (error) {
    const failure = error instanceof PlacementError
      ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : { code: task.operation === "placement" ? "PLACEMENT_TASK_ERROR" : "ROLLBACK_TASK_ERROR", message: `The ${task.operation} task failed unexpectedly; see the task's log.` };
    if (!(error instanceof PlacementError)) console.error("Placement task error:", error instanceof Error ? error.message : error);
    // A request that was never adopted (refused before the run opened) is still `queued`.
    if (task.operation === "placement") {
      await mongoPlacementTaskStore.update(input.runId, { taskRequestedAt: task.requestedAt, state: "queued" }, { state: "aborted", error: failure.message.slice(0, 300) });
    }
    await finish({ status: "failed", ...failure });
    return { ran: true, ok: false, operation: task.operation, ...failure };
  } finally {
    clearInterval(timer);
  }
};
