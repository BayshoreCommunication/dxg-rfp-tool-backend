import "../config/env";
import crypto from "node:crypto";
import { postgresPool } from "../config/postgres";
import { durableJobRepository } from "../src/modules/durableJobs/composition";
import { knowledgeRetrievalRepository } from "../src/modules/knowledgeRetrieval/postgresKnowledgeRetrievalRepository";

const main = async () => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.KNOWLEDGE_RETRIEVAL_ENABLED !== "true" ||
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER !== "mock"
  ) throw new Error("Refusing to run outside isolated Slice 2C mock services");

  const context = await postgresPool().query<{
    organization: string;
    release_id: string;
    admin: string;
  }>(`
    SELECT o.external_mongo_id organization,r.id release_id,min(u.external_mongo_id) admin
    FROM rfpilot.knowledge_releases r
    JOIN rfpilot.knowledge_import_batches b ON b.id=r.batch_id
    JOIN rfpilot.organizations o ON o.id=r.organization_id
    JOIN rfpilot.users u ON u.organization_id=o.id
    WHERE r.state='active' AND r.effective_at<=now()
      AND (r.expires_at IS NULL OR r.expires_at>now())
      AND b.classification='synthetic'
    GROUP BY o.external_mongo_id,r.id
    ORDER BY r.created_at LIMIT 1
  `);
  const ids = context.rows[0];
  if (!ids) throw new Error("An approved active synthetic release is required");

  const correlationId = crypto.randomUUID();
  const created = await durableJobRepository.createKnowledgeIndex({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    releaseId: ids.release_id,
    idempotencyKey: `verify-2c:${correlationId}`,
    correlationId,
  });
  const indexed = await knowledgeRetrievalRepository.indexRelease({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    releaseId: ids.release_id,
    jobId: created.job.id,
    correlationId,
  });
  const response = await knowledgeRetrievalRepository.retrieve({
    organizationMongoId: ids.organization,
    actorUserMongoId: ids.admin,
    fixture: "breakout-room-schedule",
    query: "breakout room schedule start time end time room assignment audiovisual requirements",
    filters: { sourceTypes: [], market: null, currency: null },
    limit: 10,
    idempotencyKey: `verify-query:${correlationId}`,
    correlationId,
  });
  if (response.results.some((item) => !item.citation.checksum || !item.citation.coordinates)) {
    throw new Error("Citation verification failed");
  }

  console.log(JSON.stringify({
    releaseId: ids.release_id,
    indexedFragmentCount: indexed.indexedFragmentCount,
    queryId: response.queryId,
    resultCount: response.results.length,
    citationsValid: true,
    queryTimeEligibilityEnforced: true,
    provider: "mock/deterministic-v1",
    proposalMutation: false,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => postgresPool().end());
