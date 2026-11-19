/* Start-up of a durable worker process (scripts/startDurableWorker.ts, scripts/startAiGatewayWorker.ts).

   Both workers REQUIRE MongoDB: the first thing every job does is ask whether its organization is
   blocked (organizationBlockDeferral.ts), and that is one MongoDB read. The connection is therefore
   awaited BEFORE the BullMQ worker exists. A worker that took jobs while still connecting would
   defer every one of them for LOOKUP_FAILED_DEFER_MS on a lookup that could not have succeeded.

   A missing `MONGODB_URL` or an unreachable MongoDB at start-up is a start-up failure: no worker is
   created, and the caller logs `message` (one line that names the worker and the cause) and exits
   non-zero. A MongoDB outage AFTER start-up is different and unchanged: jobs are deferred, never
   failed (organizationBlockDeferral.ts). */

export class WorkerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStartupError";
  }
}

/** Connection strings never reach a log line, with or without credentials. */
export const withoutConnectionStrings = (text: string) => text.replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://[redacted]");

export const startWorkerWithMongo = async <W>(input: {
  name: string;
  connect: () => Promise<unknown>;
  createWorker: () => W;
  env?: Record<string, string | undefined>;
}): Promise<W> => {
  const env = input.env ?? process.env;
  const prefix = `${input.name} cannot start: MongoDB is required (every job asks whether its organization is blocked)`;
  if (!env.MONGODB_URL && !env.MONGO_URL) throw new WorkerStartupError(`${prefix} and MONGODB_URL is not set.`);
  try {
    await input.connect();
  } catch (error) {
    const cause = withoutConnectionStrings(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
    throw new WorkerStartupError(`${prefix} and it could not be reached: ${cause}`);
  }
  return input.createWorker();
};

/** The one line a worker script logs when it cannot start. */
export const startupFailureLine = (error: unknown) => (error instanceof Error ? error.message : String(error));
