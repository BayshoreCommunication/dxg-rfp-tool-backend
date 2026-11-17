import crypto from "node:crypto";
import {
  PlacementError,
  type PlacementActor,
  type PlacementJournalEntry,
  type PlacementState,
  type PlacementTarget,
  type PlacementTaskRecord,
} from "./legacyCustomerPlacement";

// ORG-110 on production (owner's decision, 2026-11-17): the API never holds the Postgres
// migration role, so it cannot move a customer itself, and it is not allowed to start ECS tasks
// either (whoever can start a task on a definition that holds the migration role can run
// anything with it). It validates the request exactly as the synchronous path does, journals it
// as a queued run, and starts an execution of one Step Functions state machine, passing the run
// id and nothing else. The state machine runs scripts/runPlacementTask.js on a dedicated task
// definition with everything else fixed. The task reads the request from the journal, checks it
// again, runs the same placement code, and writes its outcome back.
//
// This file is the request side: queueing, idempotency, the per-user and global limits, and
// giving up on a task that never started or stopped reporting. It talks to the journal and to
// Step Functions through ports, so the rules are tested without either
// (tests/placement-tasks.test.js); the journal's unique indexes are what make the limits hold
// across API instances (placementTaskStore.ts,
// tests-integration/legacy-customer-placement-tasks.test.ts).

export type TaskOperation = PlacementTaskRecord["operation"];
export type TaskStatus = PlacementTaskRecord["status"];

export type RunExpectation = {
  // Identifies the task the caller looked at: a later task on the same run has another time.
  taskRequestedAt: Date;
  state?: PlacementState | PlacementState[];
  taskStatus?: TaskStatus | TaskStatus[];
};
export type RunChange = {
  state?: PlacementState;
  error?: string;
  task?: Partial<PlacementTaskRecord>;
  // Frees the per-user lock and the task slot.
  release?: boolean;
  clearRollbackFrom?: boolean;
  // Lets the same Idempotency-Key start a new run: set when a run ends having moved nothing.
  releaseIdempotencyKey?: boolean;
};
export type QueueRefusal = "user_busy" | "capacity" | "idempotency_key" | "state";

export interface PlacementTaskStore {
  find(runId: string): Promise<PlacementJournalEntry | null>;
  findByIdempotencyKey(key: string): Promise<PlacementJournalEntry | null>;
  // Runs whose task is queued or running.
  findActiveTasks(): Promise<PlacementJournalEntry[]>;
  // Inserts a queued placement holding the user's lock and one of `maxConcurrent` slots.
  queuePlacement(entry: PlacementJournalEntry, maxConcurrent: number): Promise<{ queued: true } | { queued: false; refusal: QueueRefusal }>;
  // done | failed → rolling_back with a queued rollback task, the user's lock and a slot.
  queueRollback(runId: string, task: PlacementTaskRecord, maxConcurrent: number): Promise<{ queued: true } | { queued: false; refusal: QueueRefusal }>;
  // Compare-and-set: applies `change` only if the run still looks like `expect`.
  update(runId: string, expect: RunExpectation, change: RunChange): Promise<boolean>;
}

export interface PlacementTaskLauncher {
  // Starts the one-off task for this run. `launchToken` names the attempt: a repeated call with
  // the same token starts nothing new.
  launch(input: { runId: string; launchToken: string }): Promise<void>;
  // What became of that attempt, for the server log only (never shown to the client).
  describe?(input: { launchToken: string }): Promise<{ status?: string; error?: string; cause?: string } | null>;
}

export type PlacementTaskPolicy = {
  // Placements take exclusive Postgres locks on a live product, so one at a time by default.
  maxConcurrent: number;
  // A queued task that hasn't started within this is given up on. A Fargate task normally
  // starts in about a minute.
  startTimeoutMs: number;
  // A running task whose last heartbeat is older than this is given up on. The task stops itself
  // well before (placementTaskRunner.ts), so a task still alive is not one the API has released.
  heartbeatTimeoutMs: number;
};
export const DEFAULT_PLACEMENT_TASK_POLICY: PlacementTaskPolicy = { maxConcurrent: 1, startTimeoutMs: 4 * 60_000, heartbeatTimeoutMs: 3 * 60_000 };
// Below these the API would give up on tasks that are merely slow: the task's own lease is 60 s
// and its heartbeat 15 s, and a task cannot start in under a minute.
export const PLACEMENT_TASK_FLOORS = { startTimeoutSeconds: 60, heartbeatTimeoutSeconds: 120 } as const;

export class PlacementTaskSettingsError extends Error {}
const setting = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PlacementTaskSettingsError(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  }
  return parsed;
};
// Throws on a value that is set but out of range; the API checks this when it starts.
export const placementTaskPolicyFromEnv = (env: NodeJS.ProcessEnv = process.env): PlacementTaskPolicy => ({
  maxConcurrent: setting(env, "PLACEMENT_TASK_MAX_CONCURRENT", DEFAULT_PLACEMENT_TASK_POLICY.maxConcurrent, 1, 5),
  startTimeoutMs: setting(env, "PLACEMENT_TASK_START_TIMEOUT_SECONDS", DEFAULT_PLACEMENT_TASK_POLICY.startTimeoutMs / 1000, PLACEMENT_TASK_FLOORS.startTimeoutSeconds, 3600) * 1000,
  heartbeatTimeoutMs: setting(env, "PLACEMENT_TASK_HEARTBEAT_TIMEOUT_SECONDS", DEFAULT_PLACEMENT_TASK_POLICY.heartbeatTimeoutMs / 1000, PLACEMENT_TASK_FLOORS.heartbeatTimeoutSeconds, 3600) * 1000,
});

export type ValidatedPlacement = Pick<PlacementJournalEntry, "holdingOrganizationId" | "previousVersion" | "targetOrganizationId" | "createdOrganization" | "role" | "teamId"> & {
  target: PlacementTarget;
};

// What the admin app polls. `status` is the run as a whole; `task` is the latest one-off task, so
// a rollback that failed shows as status "succeeded" (the placement stands) with a failed task.
export type PlacementRunStatus = "queued" | "running" | "succeeded" | "failed" | "rolled_back";
// The journal says `done` as soon as the MongoDB move commits, but the placement task still has
// the Postgres commit, the checks and the audit events to do. Until that task has finished the
// run is not something to report as succeeded, or to roll back.
export const placementTaskActive = (entry: Pick<PlacementJournalEntry, "task">) =>
  entry.task?.operation === "placement" && (entry.task.status === "queued" || entry.task.status === "running");
// A placement whose journal says `done` (the MongoDB move committed) but whose task then failed
// or was lost. `succeeded` must mean the checks passed: if they did, the placement stands and
// only its audit events are in doubt; if they did not run or did not pass, the run is one that
// has to be rolled back, whatever the journal state says.
export const unfinishedPlacementOutcome = (entry: Pick<PlacementJournalEntry, "verification">) =>
  entry.verification?.passed === true
    ? { stands: true as const, details: { verified: true, auditUnconfirmed: true } }
    : { stands: false as const, details: { rollbackRequired: true } };
const statusOf = (entry: PlacementJournalEntry): PlacementRunStatus => {
  if (placementTaskActive(entry)) return entry.state === "queued" ? "queued" : "running";
  switch (entry.state) {
    case "queued": return "queued";
    case "started": return "running";
    case "done": return "succeeded";
    case "failed":
    case "aborted": return "failed";
    case "rolling_back": return entry.task?.operation === "rollback" && entry.task.status === "queued" ? "queued" : "running";
    case "rolled_back": return "rolled_back";
  }
};
export const placementRunView = (entry: PlacementJournalEntry) => {
  // The request, the idempotency key and the slot are the API's own bookkeeping.
  const journal: Partial<PlacementJournalEntry> & { _id?: unknown } = { ...entry };
  for (const key of ["_id", "request", "idempotencyKey", "taskSlot", "inFlight", "task"] as const) delete journal[key];
  const task = entry.task;
  return {
    ...journal,
    status: statusOf(entry),
    operation: (!placementTaskActive(entry) && (entry.state === "rolling_back" || entry.state === "rolled_back") ? "rollback" : "placement") as TaskOperation,
    // A placement that moved MongoDB but not Postgres, or whose checks never ran: roll it back.
    // Not while its own task is still working on it.
    rollbackRequired: entry.state === "failed" && !placementTaskActive(entry),
    task: task
      ? {
          operation: task.operation, status: task.status, requestedAt: task.requestedAt, startedAt: task.startedAt ?? null,
          heartbeatAt: task.heartbeatAt ?? null, finishedAt: task.finishedAt ?? null,
          code: task.code ?? null, message: task.message ?? null, details: task.details ?? null,
        }
      : null,
  };
};
export type PlacementRunView = ReturnType<typeof placementRunView>;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};
// The key is stored hashed and belongs to the staff member who sent it: two people using the
// same key are two requests. Printable ASCII, as HTTP header values are.
const idempotencyKeyHash = (key: string | undefined, actor: PlacementActor) => {
  if (key === undefined || key === "") return undefined;
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new PlacementError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1 to 200 printable characters without spaces.", 400);
  return sha256(`${actor.adminUserId}:${key}`);
};
const launchTokenFor = (runId: string, task: Pick<PlacementTaskRecord, "operation" | "requestedAt">) =>
  sha256(`${runId}|${task.operation}|${task.requestedAt.toISOString()}`);

const capacityReached = () => new PlacementError("PLACEMENT_CAPACITY_REACHED", "Another placement or rollback is running. Try again when it has finished.", 429);

export const createPlacementTaskService = (deps: {
  store: PlacementTaskStore;
  launcher: PlacementTaskLauncher;
  // Throws the synchronous path's refusals (legacyCustomerPlacement.validatePlacementRequest).
  validatePlacement(userId: string, target: PlacementTarget): Promise<ValidatedPlacement>;
  // Throws ORGANIZATION_IN_USE / USER_IS_OWNER (legacyCustomerPlacement.assertRollbackAllowed).
  assertRollbackAllowed(entry: PlacementJournalEntry): Promise<void>;
  newRunId(): string;
  now?: () => Date;
  policy?: Partial<PlacementTaskPolicy>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}) => {
  const policy = { ...DEFAULT_PLACEMENT_TASK_POLICY, ...deps.policy };
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const taskFor = (operation: TaskOperation, actor: PlacementActor, keyHash?: string): PlacementTaskRecord => ({
    operation, status: "queued", requestedAt: now(), adminUserId: actor.adminUserId, adminOrganizationId: actor.adminOrganizationId,
    correlationId: actor.correlationId, ...(keyHash ? { idempotencyKey: keyHash } : {}),
  });

  // Gives up on one task. Every write is a compare-and-set on the state the task was seen in, so
  // a task that moved on in the meantime is left alone; and the run's own commit checks the
  // state too (legacyCustomerPlacement.ts), so a task that is given up on cannot commit after.
  const giveUp = async (entry: PlacementJournalEntry, reason: "not_started" | "start_failed" | "lost") => {
    const task = entry.task!;
    const prefix = task.operation === "placement" ? "PLACEMENT" : "ROLLBACK";
    const code = `${prefix}_TASK_${reason === "lost" ? "LOST" : reason === "start_failed" ? "START_FAILED" : "NOT_STARTED"}`;
    const what = task.operation === "placement" ? "placement" : "rollback";
    const why = reason === "lost" ? `The ${what} task stopped reporting` : reason === "start_failed" ? `The ${what} task could not be started` : `The ${what} task did not start in time`;
    const settle = (change: RunChange & { message: string; details?: Record<string, unknown> }) => {
      const { message, details, ...rest } = change;
      return deps.store.update(entry.runId, { taskRequestedAt: task.requestedAt, state: entry.state, taskStatus: task.status }, {
        ...rest, release: true,
        task: { status: "failed", code, message, finishedAt: now(), ...(details && Object.keys(details).length ? { details } : {}) },
      });
    };
    let settled: boolean;
    if (entry.state === "queued" || entry.state === "started") {
      // The MongoDB transaction sets `done` and Postgres commits only after it: nothing moved,
      // so the same Idempotency-Key may be used to try again.
      settled = await settle({ state: "aborted", error: `${why}; nothing was moved.`, message: `${why}; nothing was moved.`, releaseIdempotencyKey: true });
    } else if (entry.state === "rolling_back") {
      // The rollback's MongoDB transaction sets `rolled_back`: it did not happen. A placement's
      // own rollback after failed checks leaves a placement that still has to be rolled back.
      const back = task.operation === "rollback" ? entry.rollbackFrom ?? "done" : "failed";
      settled = await settle({
        state: back, clearRollbackFrom: true,
        message: task.operation === "rollback" ? `${why}; the placement was not rolled back.` : `${why} while rolling back after failed checks; roll this run back.`,
        ...(back === "failed" ? { details: { rollbackRequired: true } } : {}),
      });
    } else if (entry.state === "done" && task.operation === "placement") {
      // MongoDB committed and the task did not finish. Whether that is a placement that stands
      // depends on whether its checks passed: the same rule the task applies to itself when it
      // fails after the move (placementTaskRunner.ts).
      const outcome = unfinishedPlacementOutcome(entry);
      settled = await settle(outcome.stands
        ? { message: `${why} after the placement was made and its checks passed; check that its audit events were written.`, details: outcome.details }
        : { state: "failed", error: `${why} before its checks finished.`, message: `${why} after the move but before its checks finished; roll this run back.`, details: outcome.details });
    } else {
      // The journal reached an end state and only the task's own report is missing.
      settled = await settle({
        message: `${why} before reporting its result; the run is ${entry.state}.`,
        details: { ...(entry.state === "failed" ? { rollbackRequired: true } : {}), ...(entry.state === "rolled_back" ? { needsOperatorCheck: true } : {}) },
        ...(entry.state === "aborted" ? { releaseIdempotencyKey: true } : {}),
      });
    }
    if (settled) {
      // Why the task stopped (ECS's stop reason, an exit code) goes to the server log only.
      const execution = reason === "start_failed" ? null : await deps.launcher.describe?.({ launchToken: launchTokenFor(entry.runId, task) }).catch(() => null);
      log("placement_task_given_up", { runId: entry.runId, operation: task.operation, code, state: entry.state, ...(execution ? { execution } : {}) });
    }
    return { settled, code, message: why };
  };

  const reconcile = async () => {
    const at = now().getTime();
    for (const entry of await deps.store.findActiveTasks()) {
      const task = entry.task;
      if (!task) continue;
      if (task.status === "queued" && at - task.requestedAt.getTime() > policy.startTimeoutMs) await giveUp(entry, "not_started");
      else if (task.status === "running" && at - (task.heartbeatAt ?? task.startedAt ?? task.requestedAt).getTime() > policy.heartbeatTimeoutMs) await giveUp(entry, "lost");
    }
  };

  const start = async (runId: string): Promise<PlacementRunView> => {
    const entry = (await deps.store.find(runId))!;
    const task = entry.task!;
    try {
      await deps.launcher.launch({ runId, launchToken: launchTokenFor(runId, task) });
      // Not conditional on the status: the task may already have claimed the run.
      await deps.store.update(runId, { taskRequestedAt: task.requestedAt }, { task: { launchedAt: now() } });
      log("placement_task_started", { runId, operation: task.operation, adminUserId: task.adminUserId, correlationId: task.correlationId });
    } catch (error) {
      // If the task did start after all, it finds the request gone and does nothing. The cause
      // (which can name accounts and roles) is logged here and never stored or returned.
      const { settled, code } = await giveUp(entry, "start_failed");
      log("placement_task_start_failed", { runId, operation: task.operation, settled, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      // Not settled means a task claimed the run in the meantime: it did start, so report the run.
      if (settled) throw new PlacementError(code, `The ${task.operation} could not be started; nothing was moved. Try again.`, 503, { runId });
    }
    return placementRunView((await deps.store.find(runId))!);
  };

  const replay = (entry: PlacementJournalEntry, fingerprint: string) => {
    if (entry.request?.fingerprint !== fingerprint) {
      throw new PlacementError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used for a different request.", 409);
    }
    return { run: placementRunView(entry), replayed: true };
  };
  const staffActor = (actor: PlacementActor) => {
    const id = /^[a-f0-9]{24}$/i;
    if (!id.test(actor.adminUserId ?? "") || !id.test(actor.adminOrganizationId ?? "")) {
      throw new PlacementError("STAFF_ORGANIZATION_REQUIRED", "This staff account has no organization, so it can't place customers.", 403);
    }
  };

  return {
    reconcile,

    // 202: the run is queued and its task started. Refusals are the synchronous path's, plus 429
    // PLACEMENT_CAPACITY_REACHED and 503 PLACEMENT_TASK_START_FAILED.
    async requestPlacement(input: { userId: string; target: PlacementTarget; actor: PlacementActor; idempotencyKey?: string }) {
      staffActor(input.actor);
      const keyHash = idempotencyKeyHash(input.idempotencyKey, input.actor);
      const fingerprint = sha256(stable({ operation: "placement", userId: input.userId, target: input.target }));
      await reconcile();
      if (keyHash) {
        const existing = await deps.store.findByIdempotencyKey(keyHash);
        if (existing) return replay(existing, fingerprint);
      }
      const validated = await deps.validatePlacement(input.userId, input.target);
      const { target, ...fields } = validated;
      const runId = deps.newRunId();
      const task = taskFor("placement", input.actor, keyHash);
      const entry: PlacementJournalEntry = {
        runId, userId: input.userId, ...fields, state: "queued", inFlight: true,
        adminUserId: input.actor.adminUserId, adminOrganizationId: input.actor.adminOrganizationId,
        request: { target, fingerprint }, ...(keyHash ? { idempotencyKey: keyHash } : {}), task,
        createdAt: task.requestedAt, updatedAt: task.requestedAt,
      };
      const queued = await deps.store.queuePlacement(entry, policy.maxConcurrent);
      if (!queued.queued) {
        // A twin request with the same key won the insert. It also holds the user's lock, and the
        // journal reports only one of the two violated indexes, so look the key up either way.
        const existing = keyHash ? await deps.store.findByIdempotencyKey(keyHash) : null;
        if (existing) return replay(existing, fingerprint);
        if (queued.refusal === "capacity") throw capacityReached();
        throw new PlacementError("PLACEMENT_IN_PROGRESS", "This user is already being placed.", 409);
      }
      return { run: await start(runId), replayed: false };
    },

    async requestRollback(input: { runId: string; actor: PlacementActor; idempotencyKey?: string }) {
      staffActor(input.actor);
      const keyHash = idempotencyKeyHash(input.idempotencyKey, input.actor);
      await reconcile();
      for (let attempt = 0; ; attempt++) {
        const entry = await deps.store.find(input.runId);
        if (!entry) throw new PlacementError("PLACEMENT_NOT_FOUND", "Placement run not found.", 404);
        // A rollback task that failed moved nothing, so the same key asks again.
        if (keyHash && entry.task?.operation === "rollback" && entry.task.idempotencyKey === keyHash && entry.task.status !== "failed") {
          return { run: placementRunView(entry), replayed: true };
        }
        // Still being verified (or rolled back by its own checks) by the placement task.
        if (placementTaskActive(entry)) throw new PlacementError("PLACEMENT_IN_PROGRESS", "This placement is still running.", 409);
        if (entry.state === "rolled_back") throw new PlacementError("ALREADY_ROLLED_BACK", "This placement was already rolled back.", 409);
        if (entry.state === "rolling_back") throw new PlacementError("ROLLBACK_IN_PROGRESS", "This placement is being rolled back.", 409);
        if (entry.state === "aborted") throw new PlacementError("NOTHING_TO_ROLL_BACK", "This placement failed before anything moved.", 409);
        if (entry.state === "queued" || entry.state === "started" || placementTaskActive(entry)) throw new PlacementError("PLACEMENT_IN_PROGRESS", "This placement is still running.", 409);
        await deps.assertRollbackAllowed(entry);
        const queued = await deps.store.queueRollback(input.runId, taskFor("rollback", input.actor, keyHash), policy.maxConcurrent);
        if (queued.queued) return { run: await start(input.runId), replayed: false };
        if (queued.refusal === "capacity") throw capacityReached();
        // Another request changed the run between the read and the claim: read it again once.
        if (queued.refusal !== "state" || attempt > 0) throw new PlacementError("ROLLBACK_IN_PROGRESS", "This placement is being rolled back.", 409);
      }
    },

    // Reading a run is also when a task that never started or stopped reporting is given up on.
    async getRun(runId: string): Promise<PlacementRunView | null> {
      await reconcile();
      const entry = await deps.store.find(runId);
      return entry ? placementRunView(entry) : null;
    },
  };
};
export type PlacementTaskService = ReturnType<typeof createPlacementTaskService>;
