/* Start-up of a durable worker process (scripts/startDurableWorker.ts, scripts/startAiGatewayWorker.ts).

   Both workers REQUIRE MongoDB: the first thing every job does is ask whether its organization is
   blocked (organizationBlockDeferral.ts), and that is one MongoDB read. The connection is therefore
   awaited BEFORE the BullMQ worker exists. A worker that took jobs while still connecting would
   defer every one of them for LOOKUP_FAILED_DEFER_MS on a lookup that could not have succeeded.

   A missing `MONGODB_URL` or an unreachable MongoDB at start-up is a start-up failure: no worker is
   created, and the caller logs `message` (one line that names the worker and the cause) and exits
   non-zero. A MongoDB outage AFTER start-up is different and unchanged: jobs are deferred, never
   failed (organizationBlockDeferral.ts).

   RETRIES. An unreachable MongoDB is tried WORKER_MONGO_ATTEMPTS times before the start fails,
   waiting WORKER_MONGO_RETRY_DELAYS_MS between attempts (5 attempts, 60 s of waiting). Under ECS
   an exited task counts against the deployment circuit breaker, so one failed attempt during a
   deploy would roll the deploy back for a blip of seconds; before this change the AI gateway
   worker did not need MongoDB at start at all. The worker services have no container health
   check and no load balancer (deploy/aws/lib/app-stack.ts), so no health grace period limits how
   long a task may spend here: a task that is still retrying is simply running. The bound is for
   operators: each attempt can itself wait up to the driver's 30 s server selection
   (config/db.ts), so a start that cannot reach MongoDB fails in about 1 to 3.5 minutes instead
   of hanging. A missing `MONGODB_URL` is not retried: it cannot fix itself.

   Nothing here prints a driver error object or a connection string: `connect` is called with
   `quietFailure` (config/db.ts then skips its failure banner, whose driver message quotes a
   malformed URI), and every line built here is one line with connection strings removed. */

export class WorkerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerStartupError";
  }
}

/** Connection strings never reach a log line, with or without credentials. */
export const withoutConnectionStrings = (text: string) => text.replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://[redacted]");

export const WORKER_MONGO_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 15_000, 30_000];
export const WORKER_MONGO_ATTEMPTS = WORKER_MONGO_RETRY_DELAYS_MS.length + 1;

const oneLineCause = (error: unknown) => withoutConnectionStrings(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

export const startWorkerWithMongo = async <W>(input: {
  name: string;
  connect: (options?: { quietFailure?: boolean }) => Promise<unknown>;
  createWorker: () => W;
  env?: Record<string, string | undefined>;
  /** Waits between attempts; setTimeout when not given. */
  sleep?: (ms: number) => Promise<unknown>;
  /** One line per failed attempt that will be retried; console.warn when not given. */
  log?: (line: string) => void;
}): Promise<W> => {
  const env = input.env ?? process.env;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = input.log ?? ((line: string) => { console.warn(line); });
  const prefix = `${input.name} cannot start: MongoDB is required (every job asks whether its organization is blocked)`;
  if (!env.MONGODB_URL && !env.MONGO_URL) throw new WorkerStartupError(`${prefix} and MONGODB_URL is not set.`);
  let lastCause = "";
  for (let attempt = 1; attempt <= WORKER_MONGO_ATTEMPTS; attempt += 1) {
    try {
      await input.connect({ quietFailure: true });
    } catch (error) {
      lastCause = oneLineCause(error);
      if (attempt === WORKER_MONGO_ATTEMPTS) break;
      const delay = WORKER_MONGO_RETRY_DELAYS_MS[attempt - 1];
      log(`${input.name}: MongoDB could not be reached (attempt ${attempt} of ${WORKER_MONGO_ATTEMPTS}), trying again in ${delay / 1000} s: ${lastCause}`);
      await sleep(delay);
      continue;
    }
    return input.createWorker();
  }
  throw new WorkerStartupError(`${prefix} and it could not be reached: ${lastCause} (${WORKER_MONGO_ATTEMPTS} attempts)`);
};

/** The one line a worker script logs when it cannot start. */
export const startupFailureLine = (error: unknown) => (error instanceof Error ? error.message : String(error));
