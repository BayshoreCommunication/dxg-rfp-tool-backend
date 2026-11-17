import { PLACEMENT_INDEXES, placementJournal, type PlacementJournalEntry, type PlacementTaskRecord } from "./legacyCustomerPlacement";
import type { PlacementTaskStore, QueueRefusal, RunChange, RunExpectation } from "./placementTasks";

// The placement journal as the one-off task's request queue. The limits are unique indexes on
// the journal (one in-flight run per user, one run per idempotency key, one task per slot), so
// they hold whichever API instance or task writes.

const oneOrMany = <T>(value: T | T[]) => (Array.isArray(value) ? { $in: value } : value);
const filterFor = (runId: string, expect: RunExpectation) => ({
  runId,
  "task.requestedAt": expect.taskRequestedAt,
  ...(expect.state === undefined ? {} : { state: oneOrMany(expect.state) }),
  ...(expect.taskStatus === undefined ? {} : { "task.status": oneOrMany(expect.taskStatus) }),
});

const refusalOf = (error: unknown): QueueRefusal | null => {
  const failure = error as { code?: number; message?: string };
  if (failure?.code !== 11000) return null;
  const message = String(failure.message ?? "");
  if (message.includes(PLACEMENT_INDEXES.taskSlot)) return "capacity";
  if (message.includes(PLACEMENT_INDEXES.idempotencyKey)) return "idempotency_key";
  if (message.includes(PLACEMENT_INDEXES.inFlight)) return "user_busy";
  // runId is unique too; a collision there is not something to retry on another slot.
  return "state";
};

// Tries each slot in turn; the unique index refuses a taken one.
const inAFreeSlot = async (maxConcurrent: number, attempt: (slot: number) => Promise<boolean>): Promise<{ queued: true } | { queued: false; refusal: QueueRefusal }> => {
  for (let slot = 0; slot < maxConcurrent; slot++) {
    try {
      return (await attempt(slot)) ? { queued: true } : { queued: false, refusal: "state" };
    } catch (error) {
      const refusal = refusalOf(error);
      if (!refusal) throw error;
      if (refusal !== "capacity") return { queued: false, refusal };
    }
  }
  return { queued: false, refusal: "capacity" };
};

export const mongoPlacementTaskStore: PlacementTaskStore = {
  async find(runId) {
    return (await placementJournal()).findOne({ runId }, { projection: { _id: 0 } });
  },
  async findByIdempotencyKey(key) {
    return (await placementJournal()).findOne({ idempotencyKey: key }, { projection: { _id: 0 } });
  },
  async findActiveTasks() {
    return (await placementJournal()).find({ "task.status": { $in: ["queued", "running"] } }, { projection: { _id: 0 } }).toArray();
  },
  async queuePlacement(entry, maxConcurrent) {
    const journal = await placementJournal();
    const result = await inAFreeSlot(maxConcurrent, async (slot) => {
      await journal.insertOne({ ...entry, taskSlot: slot });
      return true;
    });
    // An insert that breaks two unique indexes reports one of them. A user who is already being
    // placed is "in progress" whether or not a slot was also free.
    if (!result.queued && result.refusal === "capacity" && await journal.findOne({ userId: entry.userId, inFlight: true }, { projection: { _id: 1 } })) {
      return { queued: false, refusal: "user_busy" };
    }
    return result;
  },
  async queueRollback(runId, task: PlacementTaskRecord, maxConcurrent) {
    const journal = await placementJournal();
    return inAFreeSlot(maxConcurrent, async (slot) => {
      const claimed = await journal.updateOne(
        // Never while a task is still working on the run: a placement is `done` in the journal
        // before its Postgres commit, checks and audit events.
        { runId, state: { $in: ["done", "failed"] }, "task.status": { $nin: ["queued", "running"] } },
        [{ $set: { rollbackFrom: "$state", state: "rolling_back", inFlight: true, taskSlot: slot, task: { $literal: task }, updatedAt: "$$NOW" } }],
      );
      return claimed.matchedCount === 1;
    });
  },
  async update(runId, expect, change: RunChange) {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (change.state !== undefined) set.state = change.state;
    if (change.error !== undefined) set.error = change.error;
    for (const [key, value] of Object.entries(change.task ?? {})) if (value !== undefined) set[`task.${key}`] = value;
    const unset: Record<string, ""> = {};
    if (change.release) Object.assign(unset, { inFlight: "", taskSlot: "" });
    if (change.clearRollbackFrom) unset.rollbackFrom = "";
    if (change.releaseIdempotencyKey) unset.idempotencyKey = "";
    const result = await (await placementJournal()).updateOne(filterFor(runId, expect), { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    return result.matchedCount === 1;
  },
};

// The task's side of the queue (placementTaskRunner.ts).
export const claimQueuedTask = async (runId: string, now = new Date()): Promise<PlacementJournalEntry | null> =>
  (await placementJournal()).findOneAndUpdate(
    { runId, "task.status": "queued" },
    { $set: { "task.status": "running", "task.startedAt": now, "task.heartbeatAt": now, updatedAt: now } },
    { returnDocument: "after", projection: { _id: 0 } },
  );

// False once the API has given up on the task: the task must stop.
export const recordTaskHeartbeat = async (runId: string, taskRequestedAt: Date, now = new Date()) =>
  (await (await placementJournal()).updateOne(
    { runId, "task.requestedAt": taskRequestedAt, "task.status": "running" },
    { $set: { "task.heartbeatAt": now } },
  )).matchedCount === 1;
