import type { Pool } from "pg";
import Admin, { ADMIN_ACCOUNT_ROLES } from "../../../modal/adminModel";
import OrganizationMembership from "../../../modal/organizationMembershipModel";
import { legacyAuthorizationRoles } from "../identity/domain/authorizationPolicy";
import { placeLegacyCustomer, PlacementError, rollbackPlacement, type PlacementActor, type PlacementJournalEntry, type PlacementTaskRecord } from "./legacyCustomerPlacement";
import { claimQueuedTask, mongoPlacementTaskStore, recordTaskHeartbeat } from "./placementTaskStore";
import { unfinishedPlacementOutcome } from "./placementTasks";

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
    // The work is done: a placement verified and audited, or a rollback committed and audited.
    // The last write records that. It is tried twice. If it cannot be written, or matches
    // nothing because the API has already given up on this task, the task says so and exits
    // non-zero: it must not report a success the journal does not show. What the API then shows
    // is decided by the journal: a verified placement stays `succeeded` (with
    // `auditUnconfirmed`); a finished rollback reads `rolled_back` with ROLLBACK_TASK_LOST and
    // `needsOperatorCheck`, because the API cannot tell it from one that stopped before its
    // Postgres commit.
    const recorded = await finish({ status: "succeeded" })
      .catch(() => finish({ status: "succeeded" }))
      .catch((error) => { console.error("Placement task: could not record its result:", error instanceof Error ? error.message : error); return false; });
    if (!recorded) {
      console.error(`Placement task: run ${input.runId} finished its ${task.operation}, but the result was not recorded (the run is no longer this task's, or the journal could not be written).`);
      return { ran: true, ok: false, operation: task.operation, code: "PLACEMENT_TASK_RESULT_NOT_RECORDED", message: `The ${task.operation} finished but its result could not be recorded; read the run.` };
    }
    return { ran: true, ok: true, operation: task.operation, result };
  } catch (error) {
    stopHeartbeat();
    const failure: { code: string; message: string; details?: Record<string, unknown> } = error instanceof PlacementError
      ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : { code: task.operation === "placement" ? "PLACEMENT_TASK_ERROR" : "ROLLBACK_TASK_ERROR", message: `The ${task.operation} task failed unexpectedly; see the task's log.` };
    if (!(error instanceof PlacementError)) console.error("Placement task error:", error instanceof Error ? error.message : error);
    const running = { ...expect, taskStatus: "running" as const };
    if (task.operation === "placement") {
      // A request that was refused before the run opened is still `queued`.
      await mongoPlacementTaskStore.update(input.runId, { ...running, state: "queued" }, { state: "aborted", error: failure.message.slice(0, 300) });
      // Nothing moved: the same Idempotency-Key may be used to try again.
      await mongoPlacementTaskStore.update(input.runId, { ...running, state: "aborted" }, { releaseIdempotencyKey: true });
      // The move committed (the journal says `done`) and this task failed after it: in its
      // checks, in recording them, or in the audit write. `done` alone must not read as a
      // placement that succeeded. Same rule as the API applies to a task it gives up on.
      const after = await mongoPlacementTaskStore.find(input.runId);
      if (after?.state === "done" && after.task?.status === "running") {
        const outcome = unfinishedPlacementOutcome(after);
        if (!outcome.stands) {
          await mongoPlacementTaskStore.update(input.runId, { ...running, state: "done" }, { state: "failed", error: "The placement task failed after the move, before its checks passed; roll this run back." });
        }
        failure.details = { ...failure.details, ...outcome.details };
      }
    } else {
      // A rollback refused before it began leaves the run claimed; give it back.
      const back = claimed.rollbackFrom === "failed" ? "failed" : "done";
      await mongoPlacementTaskStore.update(input.runId, { ...running, state: "rolling_back" }, { state: back, clearRollbackFrom: true });
      // A rollback that failed after its MongoDB half (the Postgres commit comes last) leaves
      // the journal `rolled_back` with Postgres not moved back: someone has to look.
      if ((await mongoPlacementTaskStore.find(input.runId))?.state === "rolled_back") {
        failure.details = { ...failure.details, needsOperatorCheck: true };
      }
    }
    const recorded = await finish({ status: "failed", ...failure }).catch(() => false);
    if (!recorded) console.error(`Placement task: run ${input.runId} failed (${failure.code}) and the failure was not recorded (the run is no longer this task's, or the journal could not be written).`);

    return { ran: true, ok: false, operation: task.operation, ...failure };
  }
};
