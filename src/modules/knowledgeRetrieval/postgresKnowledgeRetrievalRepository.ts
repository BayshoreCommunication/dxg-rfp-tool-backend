/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { vectorLiteral } from "./deterministicEmbedding";
import { embedTexts } from "./embeddingProvider";
import { aiEnvironment } from "../../../config/aiEnvironment";
import {
  KnowledgeRetrievalError,
  retrievalFingerprint,
  type RetrievalFilters,
  type RetrievalFixture,
} from "./domain";
const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    external,
  ]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0])
    throw new KnowledgeRetrievalError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
};
// The embedding provider is selected through the governed release registry:
// KNOWLEDGE_EMBEDDING_PROVIDER only chooses among ACTIVE policy/release rows
// for the current AI environment; nothing outside the registry can run.
const policy = async (
  c: PoolClient,
  purpose?: "retrieval_test" | "knowledge_retrieval",
) => {
  const provider = process.env.KNOWLEDGE_EMBEDDING_PROVIDER === "openai" ? "openai" : "mock";
  const r = await c.query<any>(
    `SELECT p.*,m.provider,m.model,m.dimension,m.version model_version,m.allowed_classifications
     FROM rfpilot.knowledge_retrieval_policies p
     JOIN rfpilot.embedding_model_releases m ON m.id=p.embedding_model_release_id
     WHERE p.environment=$1
       AND m.provider=$2
       AND ($3::text IS NULL OR p.purpose=$3)
       AND m.environment=p.environment
       AND p.active
       AND m.active
       AND p.classification=ANY(m.allowed_classifications)
       AND p.effective_from<=now()
       AND (p.effective_until IS NULL OR p.effective_until>now())
       AND m.effective_from<=now()
       AND (m.effective_until IS NULL OR m.effective_until>now())
     ORDER BY p.approved_at DESC
     LIMIT 1`,
    [aiEnvironment() || "test", provider, purpose ?? null],
  );
  if (!r.rows[0])
    throw new KnowledgeRetrievalError(
      "RETRIEVAL_POLICY_NOT_FOUND",
      "No active retrieval policy is available for this environment and provider.",
      503,
    );
  return r.rows[0];
};
const audit = (
  c: PoolClient,
  v: {
    org: string;
    actor: string;
    action: string;
    target: string;
    id: string;
    correlation: string;
    metadata?: object;
  },
) =>
  c.query(
    "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,'allowed',$7,$8::jsonb)",
    [
      uuidv7(),
      v.org,
      v.actor,
      v.action,
      v.target,
      v.id,
      v.correlation,
      JSON.stringify(v.metadata || {}),
    ],
  );
export const knowledgeRetrievalRepository = {
  async indexRelease(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    releaseId: string;
    jobId: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        p = await policy(c);
      const release = await c.query<any>(
        `SELECT r.id,b.classification
         FROM rfpilot.knowledge_releases r
         JOIN rfpilot.knowledge_import_batches b ON b.id=r.batch_id
         WHERE r.id=$1
           AND r.organization_id=$2
           AND r.state='active'
           AND r.effective_at<=now()
           AND (r.expires_at IS NULL OR r.expires_at>now())`,
        [input.releaseId, org],
      );
      if (!release.rows[0])
        throw new KnowledgeRetrievalError(
          "RELEASE_NOT_ELIGIBLE",
          "Release is not currently eligible.",
          409,
        );
      const allowedClassifications: string[] = p.allowed_classifications ?? ["synthetic"];
      if (!allowedClassifications.includes(release.rows[0].classification))
        throw new KnowledgeRetrievalError(
          "CLASSIFICATION_NOT_ALLOWED",
          "This release classification is not approved for the active embedding release.",
          422,
        );
      const fragments = await c.query<any>(
        `SELECT f.id,f.content,rf.fragment_checksum FROM rfpilot.knowledge_release_fragments rf JOIN rfpilot.knowledge_source_fragments f ON f.id=rf.fragment_id WHERE rf.release_id=$1 AND rf.fragment_checksum=f.checksum ORDER BY f.id`,
        [input.releaseId],
      );
      const run = await c.query<any>(
        `INSERT INTO rfpilot.knowledge_index_runs(id,organization_id,release_id,policy_id,embedding_model_release_id,job_id,status,fragment_count,started_at) VALUES($1,$2,$3,$4,$5,$6,'running',$7,now()) ON CONFLICT(release_id,policy_id) DO UPDATE SET job_id=excluded.job_id,status='running',fragment_count=excluded.fragment_count,safe_error_code=null,started_at=now(),completed_at=null,updated_at=now() RETURNING id`,
        [
          uuidv7(),
          org,
          input.releaseId,
          p.id,
          p.embedding_model_release_id,
          input.jobId,
          fragments.rowCount,
        ],
      );
      const vectors = await embedTexts(
        { provider: p.provider, model: p.model, dimension: p.dimension },
        fragments.rows.map((f) => f.content),
      );
      for (let i = 0; i < fragments.rows.length; i++) {
        const f = fragments.rows[i];
        await c.query(
          `INSERT INTO rfpilot.knowledge_fragment_embeddings(organization_id,release_id,fragment_id,embedding_model_release_id,fragment_checksum,embedding) VALUES($1,$2,$3,$4,$5,$6::vector) ON CONFLICT DO NOTHING`,
          [
            org,
            input.releaseId,
            f.id,
            p.embedding_model_release_id,
            f.fragment_checksum,
            vectorLiteral(vectors[i]),
          ],
        );
      }
      await c.query(
        "UPDATE rfpilot.knowledge_index_runs SET status='succeeded',indexed_fragment_count=$2,completed_at=now(),updated_at=now() WHERE id=$1",
        [run.rows[0].id, fragments.rowCount],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.retrieval.index",
        target: "knowledge_release",
        id: input.releaseId,
        correlation: input.correlationId,
        metadata: {
          fragmentCount: fragments.rowCount,
          policyVersion: p.version,
        },
      });
      return {
        resultReference: run.rows[0].id,
        indexedFragmentCount: fragments.rowCount,
      };
    });
  },
  async indexStatus(input: { organizationMongoId: string; releaseId: string }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      const r = await c.query<any>(
        `SELECT i.status,i.fragment_count,i.indexed_fragment_count,i.safe_error_code,
                i.started_at,i.completed_at,p.version policy_version,m.version model_version
         FROM rfpilot.knowledge_index_runs i
         JOIN rfpilot.knowledge_retrieval_policies p ON p.id=i.policy_id
         JOIN rfpilot.embedding_model_releases m ON m.id=i.embedding_model_release_id
         WHERE i.release_id=$1 AND i.organization_id=$2
         ORDER BY i.created_at DESC
         LIMIT 1`,
        [input.releaseId, org],
      );
      if (!r.rows[0])
        throw new KnowledgeRetrievalError(
          "INDEX_NOT_READY",
          "No index run exists for this release.",
          404,
        );
      return r.rows[0];
    });
  },
  async retrieve(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    fixture: RetrievalFixture | "free_text";
    query: string;
    filters: RetrievalFilters;
    limit: number;
    idempotencyKey: string;
    correlationId: string;
    purpose?: "retrieval_test" | "knowledge_retrieval";
  }) {
    const started = Date.now();
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        purpose =
          input.purpose ??
          (input.fixture === "free_text"
            ? "knowledge_retrieval"
            : "retrieval_test"),
        p = await policy(c, purpose),
        fingerprint = retrievalFingerprint({
          fixture: input.fixture,
          ...(input.fixture === "free_text" ? { query: input.query } : {}),
          filters: input.filters,
          limit: input.limit,
          purpose,
        });
      const existing = await c.query<any>(
        "SELECT id,filter_fingerprint FROM rfpilot.knowledge_retrieval_queries WHERE organization_id=$1 AND idempotency_key=$2",
        [org, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].filter_fingerprint.trim() !== fingerprint)
          throw new KnowledgeRetrievalError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different retrieval request.",
            409,
          );
        return loadResults(c, existing.rows[0].id, p.version, org);
      }
      const vector = vectorLiteral(
        (await embedTexts({ provider: p.provider, model: p.model, dimension: p.dimension }, [input.query]))[0],
      );
      const rows = await c.query<any>(
        `WITH search_query AS (
 SELECT CASE
   WHEN $12='free_text'
     THEN websearch_to_tsquery(
       'english',
       regexp_replace(trim($1), '\\s+', ' OR ', 'g')
     )
   ELSE plainto_tsquery('english',$1)
 END query
), eligible AS (
 SELECT f.id fragment_id,f.content,f.coordinates,f.checksum,doc.id document_id,r.id release_id,b.source_type,b.market,b.currency,
 ts_rank_cd(to_tsvector('english',f.content),search_query.query) lexical_score,
 COALESCE(1-(e.embedding <=> $2::vector),0) vector_score
 FROM rfpilot.knowledge_releases r
 JOIN rfpilot.knowledge_import_batches b ON b.id=r.batch_id
 JOIN rfpilot.knowledge_release_fragments rf ON rf.release_id=r.id
 JOIN rfpilot.knowledge_source_fragments f ON f.id=rf.fragment_id AND f.checksum=rf.fragment_checksum
 JOIN rfpilot.knowledge_import_documents doc ON doc.id=f.document_id
 LEFT JOIN rfpilot.knowledge_fragment_embeddings e ON e.release_id=r.id AND e.fragment_id=f.id AND e.embedding_model_release_id=$3
 CROSS JOIN search_query
 WHERE r.organization_id=$11 AND r.state='active' AND r.effective_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now()) AND b.status='approved' AND b.classification=$13 AND (cardinality($4::text[])=0 OR b.source_type=ANY($4::text[])) AND ($5::text IS NULL OR b.market=$5) AND ($6::text IS NULL OR b.currency=$6)
 ), ranked AS (SELECT *,least(1,greatest(0,($8::numeric*lexical_score)+($9::numeric*vector_score))) fused_score FROM eligible WHERE lexical_score>0 OR vector_score>0)
 SELECT * FROM ranked WHERE fused_score>=$10 ORDER BY fused_score DESC,fragment_id LIMIT $7`,
        [
          input.query,
          vector,
          p.embedding_model_release_id,
          input.filters.sourceTypes,
          input.filters.market,
          input.filters.currency,
          input.limit,
          p.lexical_weight,
          p.vector_weight,
          p.minimum_score,
          org,
          input.fixture,
          p.classification,
        ],
      );
      const queryId = uuidv7(),
        latency = Date.now() - started;
      await c.query(
        "INSERT INTO rfpilot.knowledge_retrieval_queries(id,organization_id,actor_external_user_id,policy_id,fixture,filter_fingerprint,idempotency_key,result_count,latency_ms,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          queryId,
          org,
          input.actorUserMongoId,
          p.id,
          input.fixture,
          fingerprint,
          input.idempotencyKey,
          rows.rowCount,
          latency,
          input.correlationId,
        ],
      );
      for (let i = 0; i < rows.rows.length; i++) {
        const x = rows.rows[i];
        await c.query(
          "INSERT INTO rfpilot.knowledge_retrieval_results(organization_id,query_id,rank,release_id,fragment_id,fragment_checksum,lexical_score,vector_score,fused_score,eligible_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
          [
            org,
            queryId,
            i + 1,
            x.release_id,
            x.fragment_id,
            x.checksum,
            Math.max(0, Math.min(1, Number(x.lexical_score))),
            Math.max(0, Math.min(1, Number(x.vector_score))),
            Number(x.fused_score),
          ],
        );
      }
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.retrieval.query",
        target: "knowledge_retrieval_query",
        id: queryId,
        correlation: input.correlationId,
        metadata: {
          fixture: input.fixture,
          resultCount: rows.rowCount,
          policyVersion: p.version,
        },
      });
      return {
        queryId,
        policyVersion: p.version,
        results: rows.rows.map((x: any, i: number) => result(x, i + 1)),
      };
    });
  },
};
const result = (x: any, rank: number) => ({
  rank,
  fragmentId: x.fragment_id,
  releaseId: x.release_id,
  sourceType: x.source_type,
  content: x.content,
  score: Number(x.fused_score),
  citation: {
    documentId: x.document_id,
    checksum: x.checksum.trim(),
    coordinates: x.coordinates,
  },
});
const loadResults = async (
  c: PoolClient,
  queryId: string,
  policyVersion: string,
  organizationId: string,
) => {
  const r = await c.query<any>(
    `SELECT rr.rank,rr.fused_score,f.id fragment_id,f.content,f.coordinates,
            f.checksum,doc.id document_id,rel.id release_id,b.source_type
     FROM rfpilot.knowledge_retrieval_results rr
     JOIN rfpilot.knowledge_releases rel ON rel.id=rr.release_id
     JOIN rfpilot.knowledge_source_fragments f
       ON f.id=rr.fragment_id AND f.checksum=rr.fragment_checksum
     JOIN rfpilot.knowledge_import_documents doc ON doc.id=f.document_id
     JOIN rfpilot.knowledge_import_batches b ON b.id=rel.batch_id
     WHERE rr.query_id=$1
       AND rr.organization_id=$2
       AND rel.organization_id=$2
       AND rel.state='active'
       AND rel.effective_at<=now()
       AND (rel.expires_at IS NULL OR rel.expires_at>now())
     ORDER BY rr.rank`,
    [queryId, organizationId],
  );
  return {
    queryId,
    policyVersion,
    results: r.rows.map((x: any) => result(x, x.rank)),
  };
};
