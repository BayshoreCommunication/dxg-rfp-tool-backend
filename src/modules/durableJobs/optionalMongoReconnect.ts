/* The dispatcher's OPTIONAL MongoDB connection (scripts/startDurableDispatcher.ts).

   MongoDB is used there for one thing: reconcile leaves the queued jobs of blocked organizations
   out of its batch (composition.ts). The start script tries the connection once at boot. If
   MongoDB was unreachable then, nothing tried again and the exclusion stayed off until the task
   restarted. The reconcile timer now calls `ensure()`:

   - it returns at once and never throws or rejects, whatever `connect` does, so the dispatcher can
     neither stall nor exit because of MongoDB;
   - one attempt at a time; nothing is started while a connection exists or is being opened;
   - only the FIRST connection is retried here. Once one has been established the driver
     reconnects by itself, and opening a second client over it would leak the first;
   - a failure is logged as one line without the connection string, at most once per minute. */
import { withoutConnectionStrings } from "./workerStartup";

const DISCONNECTED = 0;
export const RECONNECT_LOG_EVERY_MS = 60_000;

export const createOptionalMongoReconnect = (input: {
  /** Is `MONGODB_URL` set? Without it MongoDB is not wanted and nothing is attempted. */
  configured: () => boolean;
  /** mongoose.connection.readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting. */
  readyState: () => number;
  connect: () => Promise<unknown>;
  log: (line: string) => void;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  let attempting = false;
  let established = false;
  let lastLoggedAt: number | null = null;
  const failed = (error: unknown) => {
    try {
      const at = now();
      if (lastLoggedAt !== null && at - lastLoggedAt < RECONNECT_LOG_EVERY_MS) return;
      lastLoggedAt = at;
      const cause = withoutConnectionStrings(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
      input.log(`[dispatcher] mongodb (optional, reconcile fairness only) is not connected; retrying on the next reconcile: ${cause}`);
    } catch { /* a logger that throws must not reach the timer */ }
  };
  const ensure = (): void => {
    try {
      if (established || attempting || !input.configured()) return;
      const state = input.readyState();
      if (state === 1) { established = true; return; }
      if (state !== DISCONNECTED) return;
      attempting = true;
      void Promise.resolve()
        .then(() => input.connect())
        .then(() => { established = true; }, failed)
        .finally(() => { attempting = false; });
    } catch (error) {
      attempting = false;
      failed(error);
    }
  };
  return ensure;
};
