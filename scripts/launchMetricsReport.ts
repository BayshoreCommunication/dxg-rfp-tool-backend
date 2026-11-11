import "../config/env";
import mongoose from "mongoose";
import { DATABASE_NAME } from "../config/db";
import { launchMetricsReport, parseWindowDays } from "../src/modules/launchMetrics/domain";
import { mongoLaunchMetricsSource } from "../src/modules/launchMetrics/mongoLaunchMetricsSource";

// ORG-505: the same report as GET /api/v1/admin/launch-metrics, for an operator with database
// access. Read-only. Prints counts, rates and durations only.
const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const mongoUri = process.env.MONGODB_URL || process.env.MONGO_URL;

const main = async () => {
  if (args.has("--help")) {
    process.stdout.write(`Usage:
  npm run report:launch-metrics -- [--days=30]

Prints the Organization Accounts launch metrics as JSON: invite acceptance within 7 days, time
from accepting an invitation to the first RFP opened, organizations with 2+ active users,
RFPilot Support reads under an active grant, and orphaned RFPs. --days (1 to 365) is the window
for the invitation and support-access figures.
`);
    return;
  }
  const days = parseWindowDays(args.get("--days"));
  if (!mongoUri) throw new Error("MONGODB_URL or MONGO_URL is required");
  await mongoose.connect(mongoUri, { dbName: DATABASE_NAME });
  try {
    const report = await launchMetricsReport(mongoLaunchMetricsSource, { days });
    process.stdout.write(`${JSON.stringify({ database: DATABASE_NAME, ...report }, null, 2)}\n`);
  } finally {
    await mongoose.disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Launch metrics report failed"}\n`);
  process.exitCode = 1;
});
