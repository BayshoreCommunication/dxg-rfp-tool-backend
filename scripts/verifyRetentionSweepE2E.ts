import "../config/env";
import mongoose from "mongoose";
import connectDB from "../config/db";
import { postgresEnabled } from "../config/postgres";
import {
  retentionSweepEnabled,
  retentionSweepApplies,
  sweepExpiredArtifacts,
} from "../src/modules/dataFoundation/retentionSweeper";

/**
 * Reports what the retention sweep would remove, loading configuration and the
 * Mongo connection exactly as the running application does.
 *
 * This exists because invoking the sweeper through `ts-node -e` silently
 * reports zero: that path never imports config/env, so
 * POSTGRES_FOUNDATION_ENABLED is unset, postgresEnabled() is false, and
 * sweepExpiredArtifacts returns its empty result before touching Postgres. The
 * output is indistinguishable from "nothing has expired", which is exactly the
 * wrong thing for a tool whose job is to tell you what is about to be deleted.
 *
 *   npm run verify:retention-sweep
 *
 * Refuses to run in apply mode. Deleting is a deliberate act performed by the
 * scheduled job under RETENTION_SWEEP_APPLY, not a side effect of a
 * verification script someone ran to look at the numbers.
 */
const main = async () => {
  if (!postgresEnabled())
    throw new Error("POSTGRES_FOUNDATION_ENABLED must be true; check the loaded .env");
  if (!retentionSweepEnabled())
    throw new Error("RETENTION_SWEEP_ENABLED must be true to report on the sweep");
  if (retentionSweepApplies())
    throw new Error(
      "RETENTION_SWEEP_APPLY is set. This script only reports; unset it and use the scheduled job to delete.",
    );

  // The sweep enumerates tenants from Mongo, so the connection has to be open
  // or every organization silently resolves to none.
  await connectDB();
  const result = await sweepExpiredArtifacts();

  const total = Object.values(result.deleted).reduce((sum, n) => sum + n, 0);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `\n${total} row(s) across ${result.organizations} organization(s) would be removed.`,
  );
  if (!result.organizations)
    console.log(
      "No active organizations were found. Check the Mongo connection and organization status before reading this as 'nothing to do'.",
    );
  if (!total && result.organizations)
    console.log("Nothing has passed its retention window yet.");
};

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
