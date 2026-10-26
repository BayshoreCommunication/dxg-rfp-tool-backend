import type { SupportDeskSweepResult } from "../../application/supportDeskSweeper";
import { supportRedis } from "../redis/supportRedis";

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
// Shorter than the interval, so a crashed holder never blocks the next run.
const LOCK_TTL_MS = 4 * 60 * 1000;
const LOCK_KEY = "support:sweeper:lock";

/**
 * Runs the support desk sweeper every 5 minutes on every API instance, with a
 * Redis lock so only one instance sweeps per round. It is deliberately not
 * behind CRON_ENABLED: production runs the API with crons off and the cron
 * service scaled to zero, and auto-close and escalations must still happen.
 * SUPPORT_DESK_SWEEPER_ENABLED=false turns it off.
 */
export const startSupportDeskSweeper = (sweeper: { run(): Promise<SupportDeskSweepResult> }): void => {
  if (process.env.SUPPORT_DESK_SWEEPER_ENABLED === "false") {
    console.log("⏭  Support desk sweeper disabled (SUPPORT_DESK_SWEEPER_ENABLED=false)");
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const redis = supportRedis();
      if (redis) {
        const acquired = await redis.set(LOCK_KEY, String(process.pid), "PX", LOCK_TTL_MS, "NX");
        if (acquired !== "OK") return;
      }
      const result = await sweeper.run();
      if (result.escalated || result.reminded || result.resolved || result.closed || result.failed || result.backfilled) {
        console.log("Support desk sweep:", JSON.stringify(result));
      }
    } catch (error) {
      console.error("Support desk sweep failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_RUN_DELAY_MS).unref();
  setInterval(() => void tick(), INTERVAL_MS).unref();
};
