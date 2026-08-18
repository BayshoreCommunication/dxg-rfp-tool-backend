/**
 * Projects mutable legacy VendorResponse rows into stable submissions plus an
 * immutable version 1. Dry-run is the default. Replays are safe because the
 * version idempotency key is derived from the legacy response id.
 */
import "../config/env";
import crypto from "node:crypto";
import mongoose from "mongoose";
import connectDB from "../config/db";
import {
  closePostgres,
  postgresEnabled,
  postgresPool,
} from "../config/postgres";
import VendorResponse from "../modal/vendorResponseModel";
import { mongoVendorSubmissionRepository } from "../src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionRepository";
import { postgresVendorSubmissionSourceRegistry } from "../src/modules/vendorResponses/infrastructure/postgres/postgresVendorSubmissionSourceRegistry";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const apply = args.get("--apply") === "true";
const responseId = args.get("--response-id");
const runId =
  args.get("--run-id") || `vendor-submission-versions-${new Date().toISOString()}`;
const requestedLimit = Number.parseInt(args.get("--limit") || "1000", 10);
const limit = Number.isFinite(requestedLimit)
  ? Math.min(10_000, Math.max(1, requestedLimit))
  : 1000;

const help = () =>
  process.stdout.write(`Usage:
  npm run backfill:vendor-submission-versions -- [--limit=1000] [--response-id=<mongo-id>] [--run-id=<id>]
  npm run backfill:vendor-submission-versions -- --apply [--limit=1000] [--response-id=<mongo-id>] [--run-id=<id>]

Default mode is dry-run. The projection is idempotent and preserves VendorResponse as a latest-version compatibility record.
`);

const writeJournal = async (input: {
  sourceCount: number;
  appliedCount: number;
  conflictCount: number;
  checksum: string;
  details: object;
}) => {
  if (!postgresEnabled()) return;
  const outcome = apply ? "applied" : "dry_run";
  await postgresPool().query(
    `INSERT INTO rfpilot.migration_journal(
       id,run_id,migration_type,source_system,source_count,applied_count,
       conflict_count,checksum,outcome,details
     ) VALUES(gen_random_uuid(),$1,'vendor_submission_version_backfill',
       'mongodb.vendor_responses',$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (run_id,migration_type,outcome) DO UPDATE SET
       source_count=EXCLUDED.source_count,
       applied_count=EXCLUDED.applied_count,
       conflict_count=EXCLUDED.conflict_count,
       checksum=EXCLUDED.checksum,
       details=EXCLUDED.details`,
    [
      runId,
      input.sourceCount,
      input.appliedCount,
      input.conflictCount,
      input.checksum,
      outcome,
      JSON.stringify(input.details),
    ],
  );
};

const main = async () => {
  if (args.has("--help")) return help();
  if (responseId && !mongoose.isValidObjectId(responseId)) {
    throw new Error("--response-id must be a valid Mongo id");
  }
  await connectDB();
  const query = responseId ? { _id: responseId } : {};
  const responses = await VendorResponse.find(query)
    .select("_id organizationId submissionId currentVersionNumber")
    .sort({ _id: 1 })
    .limit(limit)
    .lean();
  const candidateIds = responses.map((response) => String(response._id));
  const checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(candidateIds))
    .digest("hex");
  let appliedCount = 0;
  let alreadyProjected = 0;
  let sourceRegistered = 0;
  let sourcePending = 0;
  const conflicts: Array<{ responseId: string; code: string }> = [];

  if (apply) {
    for (const response of responses) {
      const id = String(response._id);
      try {
        if (response.submissionId && Number(response.currentVersionNumber) > 0) {
          alreadyProjected += 1;
        }
        const projected = await mongoVendorSubmissionRepository.projectLegacyResponse(id);
        if (!projected) {
          conflicts.push({ responseId: id, code: "RESPONSE_NOT_FOUND" });
          continue;
        }
        const version = await mongoVendorSubmissionRepository.findVersionByIdempotencyKey({
          organizationId: String(response.organizationId),
          idempotencyKey: `vendor_submission:legacy:${id}`,
        });
        if (version) {
          const registration = await postgresVendorSubmissionSourceRegistry.register(version);
          sourceRegistered += registration.registered;
          sourcePending += registration.pending;
        }
        appliedCount += 1;
      } catch (error) {
        conflicts.push({
          responseId: id,
          code:
            error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code || "PROJECTION_FAILED")
              : "PROJECTION_FAILED",
        });
      }
    }
  }

  const details = {
    mode: apply ? "apply" : "dry-run",
    runId,
    limit,
    alreadyProjected,
    sourceRegistered,
    sourcePending,
    conflicts: conflicts.slice(0, 20),
  };
  await writeJournal({
    sourceCount: responses.length,
    appliedCount,
    conflictCount: conflicts.length,
    checksum,
    details,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ...details,
        sourceCount: responses.length,
        appliedCount,
        conflictCount: conflicts.length,
        checksum,
      },
      null,
      2,
    )}\n`,
  );
  if (conflicts.length) process.exitCode = 1;
};

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    await closePostgres();
  });
