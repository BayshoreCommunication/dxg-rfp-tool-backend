import type { Pool } from "pg";
import Admin, { ADMIN_ACCOUNT_ROLES } from "../../../modal/adminModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import { legacyAuthorizationRoles } from "../identity/domain/authorizationPolicy";
import { placeLegacyCustomer, PlacementError, rollbackPlacement, type PlacementActor, type PlacementJournalEntry, type PlacementTaskRecord } from "./legacyCustomerPlacement";
import { claimQueuedTask, mongoPlacementTaskStore, recordTaskHeartbeat } from "./placementTaskStore";

// The task's side of a queued run (scripts/runPlacementTask.js --task-run=<runId>): claim the
// request the API journaled, run the same placement or rollback the synchronous path runs, and
// write the outcome where GET /placements/:runId reads it.
//
// This process holds the Postgres migration role and the API that wrote the journal entry does
// not, so the entry is treated as a request, not as an instruction: the staff member is looked
// up again here, a placement is validated again from the database, and a rollback's
// organizations are checked against the customer (legacyCustomerPlacement.ts).
//
// While it works it writes a heartbeat. The API gives up on a task whose heartbeat is three
// minutes old; this side stops itself after one minute without a successful heartbeat, or as
// soon as a heartbeat shows the API has given up, so the two never both believe they own a run.

export type PlacementTaskOutcome =
  | { ran: false; reason: "NOT_QUEUED" }
  | { ran: true; ok: true; operation: "placement" | "rollback"; result: unknown }
  | { ran: true; ok: false; operation: "placement" | "rollback"; code: string; message: string; details?: Record<string, unknown> };

const isObjectId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const STAFF_MEMBERSHIP_ROLES = [...new Set(ADMIN_ACCOUNT_ROLES.flatMap(legacyAuthorizationRoles))];

// The staff member the request names must still be one: an unblocked account in the `admins`
// collection, belonging to the organization the request names, with a staff membership there.
// The same double check the staff-only routes make (role and `admins` account).
const staffActorOf = async (task: PlacementTaskRecord): Promise<PlacementActor> => {
  const refuse = () => new PlacementError("PLACEMENT_REQUEST_INVALID", "The queued request doesn't name an active staff member; nothing was moved.", 403);
  if (!isObjectId(task.adminUserId) || !isObjectId(task.adminOrganizationId) || typeof task.correlationId !== "string") throw refuse();
  const admin = await Admin.findOne({ _id: task.adminUserId, isBlocked: { $ne: true } }).select("organizationId role").lean();
  if (!admin || String(admin.organizationId) !== task.adminOrganizationId || !(ADMIN_ACCOUNT_ROLES as readonly string[]).includes(String(admin.role))) throw refuse();
  const membership = await OrganizationMembership.exists({
    organizationId: admin.organizationId, userId: admin._id, status: "active", roles: { $in: STAFF_MEMBERSHIP_ROLES },
  });
  if (!membership) throw refuse();
  return { adminUserId: task.adminUserId, adminOrganizationId: task.adminOrganizationId, correlationId: task.correlationId.slice(0, 200) };
};

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
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (Date.now() - startedAt > (input.maxRunMs ?? 30 * 60_000)) return input.onLeaseLost("the task ran past its time limit");
    if (Date.now() - lastBeat > leaseMs) return input.onLeaseLost("no heartbeat could be written within the lease");
    if (beating) return;
    beating = true;
    recordTaskHeartbeat(input.runId, task.requestedAt)
      // `stopped`: the work is over and the task record is being closed, which a heartbeat still
      // in flight would see as "no longer running". That is not a lost lease.
      .then((owned) => { if (owned) lastBeat = Date.now(); else if (!stopped) input.onLeaseLost("the API gave up on this task"); })
      .catch(() => undefined)
      .finally(() => { beating = false; });
  }, heartbeatMs);
  timer.unref();
  const stopHeartbeat = () => { stopped = true; clearInterval(timer); };

  const expect = { taskRequestedAt: task.requestedAt };
  const finish = (change: { status: "succeeded" | "failed"; code?: string; message?: string; details?: Record<string, unknown> }) =>
    mongoPlacementTaskStore.update(input.runId, { ...expect, taskStatus: "running" }, { release: true, task: { ...change, finishedAt: new Date() } });

  try {
    const actor = await staffActorOf(task);
    let result: unknown;
    if (task.operation === "placement") {
      if (!claimed.request?.target || typeof claimed.request.target !== "object") throw new PlacementError("PLACEMENT_REQUEST_INVALID", "The queued request names no target.", 400);
      result = await placeLegacyCustomer({
        userId: claimed.userId, target: claimed.request.target, actor, pool: input.pool,
        adoptQueuedRun: { runId: input.runId, taskRequestedAt: task.requestedAt },
      });
    } else {
      result = await rollbackPlacement({ runId: input.runId, actor, pool: input.pool, adoptQueued: { taskRequestedAt: task.requestedAt } });
    }
    stopHeartbeat();
    await finish({ status: "succeeded" });
    return { ran: true, ok: true, operation: task.operation, result };
  } catch (error) {
    stopHeartbeat();
    const failure = error instanceof PlacementError
      ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : { code: task.operation === "placement" ? "PLACEMENT_TASK_ERROR" : "ROLLBACK_TASK_ERROR", message: `The ${task.operation} task failed unexpectedly; see the task's log.` };
    if (!(error instanceof PlacementError)) console.error("Placement task error:", error instanceof Error ? error.message : error);
    if (task.operation === "placement") {
      // A request that was refused before the run opened is still `queued`.
      await mongoPlacementTaskStore.update(input.runId, { ...expect, state: "queued" }, { state: "aborted", error: failure.message.slice(0, 300) });
      // Nothing moved: the same Idempotency-Key may be used to try again.
      await mongoPlacementTaskStore.update(input.runId, { ...expect, state: "aborted" }, { releaseIdempotencyKey: true });
    } else {
      // A rollback refused before it began leaves the run claimed; give it back.
      const back = claimed.rollbackFrom === "failed" ? "failed" : "done";
      await mongoPlacementTaskStore.update(input.runId, { ...expect, state: "rolling_back", taskStatus: "running" }, { state: back, clearRollbackFrom: true });
    }
    await finish({ status: "failed", ...failure });
    return { ran: true, ok: false, operation: task.operation, ...failure };
  }
};
