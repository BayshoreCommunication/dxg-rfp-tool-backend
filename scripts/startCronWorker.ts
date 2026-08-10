import "../config/env";
import "../config/observability";
import mongoose from "mongoose";
import connectDB from "../config/db";
import { closePostgres } from "../config/postgres";
import { startCronJobs } from "../utils/cronJobs";

const start = async (): Promise<void> => {
  await connectDB();
  startCronJobs();
  console.log("Cron worker started");
};

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — stopping cron worker`);
  void (async () => {
    try {
      await closePostgres();
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    } catch (error) {
      console.error("Cron worker shutdown error:", error);
    } finally {
      process.exit(0);
    }
  })();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("Cron worker unhandled rejection:", error);
  process.exit(1);
});

void start().catch((error) => {
  console.error("Cron worker failed to start:", error);
  process.exit(1);
});
