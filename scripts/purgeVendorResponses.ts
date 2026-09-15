/**
 * Production vendor-response cutover.
 *
 * Dry-run is the default. Apply is intentionally guarded by NODE_ENV and an
 * exact confirmation phrase because this permanently removes response data.
 * Output is counts only: never log answer text, contacts, filenames, URLs,
 * grants, or storage keys.
 */
import "../config/env";
import mongoose from "mongoose";
import { v7 as uuidv7 } from "uuid";
import connectDB from "../config/db";
import { closePostgres, postgresEnabled, withPostgresTransaction } from "../config/postgres";
import Notification from "../modal/notificationModel";
import Proposal from "../modal/proposalsModel";
import VendorConfirmationDelivery from "../modal/vendorConfirmationDeliveryModel";
import VendorResponse from "../modal/vendorResponseModel";
import VendorSubmission from "../modal/vendorSubmissionModel";
import VendorSubmissionDraft from "../modal/vendorSubmissionDraftModel";
import VendorSubmissionVersion from "../modal/vendorSubmissionVersionModel";
import { s3PrivateDocumentStorage } from "../src/modules/documentIngestion/s3PrivateDocumentStorage";
import { governedVendorObjectKey } from "../src/modules/vendorResponses/infrastructure/storage/spacesVendorDocumentStorage";

const CONFIRMATION = "DELETE_ALL_VENDOR_RESPONSES";

type StoredDocument = {
  objectKey?: unknown;
  sourceId?: unknown;
  url?: unknown;
};

type StoredRecord = {
  _id?: unknown;
  organizationId?: unknown;
  proposalId?: unknown;
  submissionId?: unknown;
  documents?: StoredDocument[];
};

const strings = (values: unknown[]): string[] => [
  ...new Set(values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )),
];

const documentObjectKey = (document: StoredDocument): string | null => {
  if (typeof document.objectKey === "string" && document.objectKey) {
    return document.objectKey;
  }
  return typeof document.url === "string"
    ? governedVendorObjectKey(document.url)
    : null;
};

const help = () => process.stdout.write(`Usage:
  npm run purge:vendor-responses
  npm run purge:vendor-responses -- --apply --confirm=${CONFIRMATION}

Dry-run is the default. Apply permanently removes all vendor responses,
submission versions, drafts, confirmation delivery records, response
notifications, and current private response objects. It tombstones registered
document sources and marks all proposals structured_v1. Questionnaire
publications and invitation grants are retained.
`);

const setPostgresTenant = async (
  organizationMongoId: string,
  sourceIds: string[],
  submissionIds: string[],
) => withPostgresTransaction(async (client) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    organizationMongoId,
  ]);
  const organization = await client.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [organizationMongoId],
  );
  if (!organization.rows[0]) return 0;
  const organizationId = organization.rows[0].id;
  await client.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
  const result = await client.query(
    `UPDATE rfpilot.document_sources
        SET deleted_at=now(),status='deleted',updated_at=now()
      WHERE organization_id=$1 AND deleted_at IS NULL
        AND (
          vendor_submission_mongo_id = ANY($2::varchar[])
          OR id::text = ANY($3::varchar[])
        )`,
    [organizationId, submissionIds, sourceIds],
  );
  await client.query(
    `INSERT INTO rfpilot.audit_events(
       id,organization_id,actor_external_user_id,action,target_type,target_id,
       decision,correlation_id,metadata
     ) VALUES($1,$2,$3,'vendor_responses_purged','vendor_response_set',$4,
       'allowed',$5,$6::jsonb)`,
    [
      uuidv7(),
      organizationId,
      null,
      organizationMongoId,
      uuidv7(),
      JSON.stringify({ sourceCount: result.rowCount ?? 0 }),
    ],
  );
  return result.rowCount ?? 0;
});

const main = async () => {
  if (process.argv.includes("--help")) return help();
  const apply = process.argv.includes("--apply");
  const confirmation = process.argv
    .find((argument) => argument.startsWith("--confirm="))
    ?.slice("--confirm=".length);

  if (apply && process.env.NODE_ENV !== "production") {
    throw new Error("Apply is permitted only with NODE_ENV=production");
  }
  if (apply && confirmation !== CONFIRMATION) {
    throw new Error(`Apply requires --confirm=${CONFIRMATION}`);
  }

  await connectDB();
  const [responses, submissions, versions, drafts, confirmationDeliveries, notifications] =
    await Promise.all([
      VendorResponse.find({})
        .select("organizationId proposalId submissionId documents")
        .lean<StoredRecord[]>(),
      VendorSubmission.find({})
        .select("organizationId proposalId _id")
        .lean<StoredRecord[]>(),
      VendorSubmissionVersion.find({})
        .select("organizationId proposalId submissionId documents")
        .lean<StoredRecord[]>(),
      VendorSubmissionDraft.find({})
        .select("organizationId proposalId submissionId documents")
        .lean<StoredRecord[]>(),
      VendorConfirmationDelivery.countDocuments({}),
      Notification.countDocuments({ type: "vendor_response" }),
    ]);

  const records = [...responses, ...submissions, ...versions, ...drafts];
  const documents = [
    ...responses.flatMap((record) => record.documents ?? []),
    ...versions.flatMap((record) => record.documents ?? []),
    ...drafts.flatMap((record) => record.documents ?? []),
  ];
  const objectKeys = strings(documents.map(documentObjectKey));
  const sourceIds = strings(documents.map((document) => document.sourceId));
  const externalDocumentsWithoutCurrentKey = documents.filter(
    (document) => typeof document.url === "string"
      && document.url.length > 0
      && documentObjectKey(document) === null,
  ).length;
  const organizationIds = strings(records.map((record) =>
    record.organizationId ? String(record.organizationId) : null));
  const submissionIds = strings([
    ...submissions.map((record) => record._id ? String(record._id) : null),
    ...records.map((record) =>
      record.submissionId ? String(record.submissionId) : null),
  ]);
  const proposalsToActivate = await Proposal.countDocuments({
    "proposalSettings.vendorResponseFormat": { $ne: "structured_v1" },
  });

  const inventory = {
    mode: apply ? "apply" : "dry-run",
    responses: responses.length,
    submissions: submissions.length,
    versions: versions.length,
    drafts: drafts.length,
    confirmationDeliveries,
    notifications,
    privateObjects: objectKeys.length,
    registeredSources: sourceIds.length,
    externalDocumentsWithoutCurrentKey,
    organizations: organizationIds.length,
    proposalsToActivate,
  };
  process.stdout.write(`${JSON.stringify({ phase: "inventory", ...inventory })}\n`);
  if (!apply) return;
  if (externalDocumentsWithoutCurrentKey > 0) {
    throw new Error(
      "Apply refused because one or more response documents lack a current private-storage key",
    );
  }

  let postgresSourcesTombstoned = 0;
  if (postgresEnabled()) {
    for (const organizationId of organizationIds) {
      const organizationRecords = records.filter(
        (record) => String(record.organizationId) === organizationId,
      );
      const organizationSubmissionIds = strings([
        ...organizationRecords.map((record) =>
          record._id ? String(record._id) : null),
        ...organizationRecords.map((record) =>
          record.submissionId ? String(record.submissionId) : null),
      ]).filter((id) => submissionIds.includes(id));
      const organizationSourceIds = strings(
        organizationRecords.flatMap((record) =>
          (record.documents ?? []).map((document) => document.sourceId)),
      ).filter((id) => sourceIds.includes(id));
      postgresSourcesTombstoned += await setPostgresTenant(
        organizationId,
        organizationSourceIds,
        organizationSubmissionIds,
      );
    }
  }

  for (const objectKey of objectKeys) {
    await s3PrivateDocumentStorage.delete(objectKey);
  }

  const session = await mongoose.startSession();
  let deleted = {
    responses: 0,
    submissions: 0,
    versions: 0,
    drafts: 0,
    confirmationDeliveries: 0,
    notifications: 0,
    proposalsActivated: 0,
  };
  try {
    await session.withTransaction(async () => {
      const deliveryResult = await VendorConfirmationDelivery.collection.deleteMany({}, { session });
      const notificationResult = await Notification.collection.deleteMany(
        { type: "vendor_response" },
        { session },
      );
      const draftResult = await VendorSubmissionDraft.collection.deleteMany({}, { session });
      const versionResult = await VendorSubmissionVersion.collection.deleteMany({}, { session });
      const submissionResult = await VendorSubmission.collection.deleteMany({}, { session });
      const responseResult = await VendorResponse.collection.deleteMany({}, { session });
      const proposalResult = await Proposal.collection.updateMany(
        {},
        [{
          $set: {
            proposalSettings: {
              $mergeObjects: [
                {
                  $cond: [
                    { $eq: [{ $type: "$proposalSettings" }, "object"] },
                    "$proposalSettings",
                    {},
                  ],
                },
                { vendorResponseFormat: "structured_v1" },
              ],
            },
          },
        }],
        { session },
      );
      deleted = {
        responses: responseResult.deletedCount,
        submissions: submissionResult.deletedCount,
        versions: versionResult.deletedCount,
        drafts: draftResult.deletedCount,
        confirmationDeliveries: deliveryResult.deletedCount,
        notifications: notificationResult.deletedCount,
        proposalsActivated: proposalResult.modifiedCount,
      };
    });
  } finally {
    await session.endSession();
  }

  process.stdout.write(`${JSON.stringify({
    phase: "complete",
    ...deleted,
    privateObjectsDeleted: objectKeys.length,
    postgresSourcesTombstoned,
  })}\n`);
};

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePostgres().catch(() => undefined);
    await mongoose.disconnect().catch(() => undefined);
  });
