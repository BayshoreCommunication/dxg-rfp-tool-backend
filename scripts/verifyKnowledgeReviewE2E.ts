import crypto from "node:crypto";
import { postgresPool } from "../config/postgres";
import { knowledgeReviewRepository } from "../src/modules/knowledgeReview/postgresKnowledgeReviewRepository";

const main = async () => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.KNOWLEDGE_REVIEW_ENABLED !== "true"
  ) {
    throw new Error("Refusing to run outside isolated Slice 2B services");
  }
  if (process.env.KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED === "true") {
    throw new Error(
      "This interim same-admin verifier requires KNOWLEDGE_INDEPENDENT_APPROVAL_REQUIRED=false",
    );
  }

  const context = await postgresPool().query<{
    organization: string;
    batch_id: string;
    admin: string;
  }>(`
    SELECT
      o.external_mongo_id organization,
      b.id batch_id,
      min(u.external_mongo_id) admin
    FROM rfpilot.knowledge_import_batches b
    JOIN rfpilot.organizations o ON o.id = b.organization_id
    JOIN rfpilot.users u ON u.organization_id = o.id
    WHERE b.status = 'needs_review'
    GROUP BY o.external_mongo_id, b.id
    ORDER BY b.created_at
    LIMIT 1
  `);
  const ids = context.rows[0];
  if (!ids) throw new Error("One test admin and a needs-review batch are required");

  const correlationId = crypto.randomUUID();
  const version = await knowledgeReviewRepository.start({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    batchId: ids.batch_id,
    correlationId,
  });
  const detail = await knowledgeReviewRepository.detail({
    organizationMongoId: ids.organization,
    batchId: ids.batch_id,
    limit: 200,
    offset: 0,
  });
  if (detail.total > 200) throw new Error("Verifier requires a bounded synthetic batch");

  for (const fragment of detail.fragments) {
    await knowledgeReviewRepository.decide({
      organizationMongoId: ids.organization,
      actorUserMongoId: ids.admin,
      reviewVersionId: version.id,
      fragmentId: fragment.id,
      decision: "accepted",
      reason: null,
      correlationId,
    });
  }

  const submitted = await knowledgeReviewRepository.submit({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    reviewVersionId: version.id,
    effectiveAt: null,
    expiresAt: null,
    correlationId,
  });
  const approved = await knowledgeReviewRepository.decideApproval({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    reviewVersionId: version.id,
    decision: "approved",
    reason: null,
    correlationId,
  });
  const releases = await knowledgeReviewRepository.releases(ids.organization);
  const release = releases.find(
    (row: { id: string; state: string; fragment_count: string | number }) =>
      row.id === approved.releaseId,
  );
  if (
    !release ||
    release.state !== "active" ||
    Number(release.fragment_count) !== detail.total
  ) {
    throw new Error("Approved release assertions failed");
  }

  const audit = await postgresPool().query<{
    submitted_by_external_user_id: string;
    decided_by_external_user_id: string;
    approved_by_external_user_id: string;
  }>(
    `SELECT
       v.submitted_by_external_user_id,
       d.decided_by_external_user_id,
       r.approved_by_external_user_id
     FROM rfpilot.knowledge_review_versions v
     JOIN rfpilot.knowledge_approval_decisions d ON d.review_version_id = v.id
     JOIN rfpilot.knowledge_releases r ON r.review_version_id = v.id
     WHERE v.id = $1`,
    [version.id],
  );
  const actors = audit.rows[0];
  if (
    submitted.submitted_by_external_user_id !== ids.admin ||
    !actors ||
    actors.submitted_by_external_user_id !== ids.admin ||
    actors.decided_by_external_user_id !== ids.admin ||
    actors.approved_by_external_user_id !== ids.admin
  ) {
    throw new Error("Separate submission and approval audit records were not preserved");
  }

  console.log(
    JSON.stringify(
      {
        batchId: ids.batch_id,
        reviewVersionId: version.id,
        sameAdminApproval: true,
        submissionActorRecorded: true,
        approvalActorRecorded: true,
        releaseId: approved.releaseId,
        releaseState: release.state,
        fragmentCount: Number(release.fragment_count),
        retrievalEnabled: false,
      },
      null,
      2,
    ),
  );
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => postgresPool().end());
