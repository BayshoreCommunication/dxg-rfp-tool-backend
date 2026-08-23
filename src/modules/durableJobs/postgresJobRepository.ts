import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { DurableJobError, attemptBudget, type DurableJob, type QueueMessage } from "./domain";
import type { JobRepository } from "./jobRepository";
type Row = {
  id: string;
  organization_id: string;
  job_type: string;
  status: DurableJob["status"];
  input_reference: string | null;
  input_version: string | null;
  progress: number;
  progress_stage: string | null;
  attempt_count: number;
  max_attempts: number;
  cancellation_requested_at: Date | null;
  error_code: string | null;
  result_reference: string | null;
  initiator_external_user_id: string | null;
  lease_owner: string | null;
  created_at: Date;
  updated_at: Date;
};
const map = (r: Row): DurableJob => ({
  id: r.id,
  type: r.job_type,
  status: r.status,
  inputReference: r.input_reference,
  inputVersion: r.input_version,
  progress: r.progress,
  progressStage: r.progress_stage,
  attemptCount: r.attempt_count,
  maxAttempts: r.max_attempts,
  cancellationRequested: Boolean(r.cancellation_requested_at),
  errorCode: r.error_code,
  resultReference: r.result_reference,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const tenant = async (c: PoolClient, mongoId: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    mongoId,
  ]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [mongoId],
  );
  if (!r.rows[0])
    throw new DurableJobError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
};
const getRow = async (c: PoolClient, id: string, lock = false) => {
  const r = await c.query<Row>(
    `SELECT * FROM rfpilot.ai_jobs WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  if (!r.rows[0])
    throw new DurableJobError("JOB_NOT_FOUND", "Job was not found.", 404);
  return r.rows[0];
};
const audit = (
  c: PoolClient,
  v: {
    organizationId: string;
    actor?: string;
    action: string;
    jobId: string;
    decision?: string;
    correlationId: string;
    metadata?: object;
  },
) =>
  c.query(
    `INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,'job',$5,$6,$7,$8::jsonb)`,
    [
      uuidv7(),
      v.organizationId,
      v.actor ?? null,
      v.action,
      v.jobId,
      v.decision ?? "allowed",
      v.correlationId,
      JSON.stringify(v.metadata ?? {}),
    ],
  );
const messageFrom = async (c: PoolClient, row: Row): Promise<QueueMessage> => {
  const org = await c.query<{ external_mongo_id: string }>(
    "SELECT external_mongo_id FROM rfpilot.organizations WHERE id=(SELECT organization_id FROM rfpilot.ai_jobs WHERE id=$1)",
    [row.id],
  );
  return {
    jobId: row.id,
    organizationMongoId: org.rows[0].external_mongo_id,
    actorUserMongoId: row.initiator_external_user_id!,
    jobType: row.job_type as QueueMessage["jobType"],
    inputReference: row.input_reference!,
    inputVersion: row.input_version,
    correlationId: row.id,
  };
};
export const postgresJobRepository: JobRepository = {
  createSourceScan(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const source = await c.query<{
        id: string;
        status: string;
        sha256: string | null;
      }>(
        `SELECT s.id,s.status,o.sha256 FROM rfpilot.document_sources s JOIN rfpilot.document_objects o ON o.source_id=s.id WHERE s.id=$1`,
        [input.sourceId],
      );
      if (!source.rows[0])
        throw new DurableJobError(
          "SOURCE_NOT_FOUND",
          "Document source was not found.",
          404,
        );
      if (!["uploaded", "scan_failed"].includes(source.rows[0].status))
        throw new DurableJobError(
          "INVALID_SOURCE_STATE",
          "Document is not ready to queue for scanning.",
          409,
        );
      const key = `source_security_scan:${input.idempotencyKey}`;
      const existing = await c.query<Row>(
        "SELECT * FROM rfpilot.ai_jobs WHERE organization_id=$1 AND idempotency_key=$2",
        [organizationId, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].input_reference !== input.sourceId)
          throw new DurableJobError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for different input.",
            409,
          );
        return { job: map(existing.rows[0]), created: false };
      }
      const id = uuidv7();
      const created = await c.query<Row>(
        `INSERT INTO rfpilot.ai_jobs(id,organization_id,job_type,status,idempotency_key,input_reference,input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,'source_security_scan','queued',$3,$4,$5::text,$5::char(64),$8,$6,$7) RETURNING *`,
        [
          id,
          organizationId,
          key,
          input.sourceId,
          source.rows[0].sha256,
          input.correlationId,
          input.actorUserMongoId,
          Number(process.env.JOB_MAX_ATTEMPTS || 5),
        ],
      );
      const payload = {
        jobId: id,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "source_security_scan",
        inputReference: input.sourceId,
        inputVersion: source.rows[0].sha256,
        correlationId: input.correlationId,
      };
      await c.query(
        `INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)`,
        [
          uuidv7(),
          organizationId,
          id,
          `job.queued:${id}:1`,
          JSON.stringify(payload),
        ],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.create",
        jobId: id,
        correlationId: input.correlationId,
      });
      return { job: map(created.rows[0]), created: true };
    });
  },
  createAiTest(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const key = `ai_gateway_test:${input.idempotencyKey}`;
      const existing = await c.query<Row>(
        "SELECT * FROM rfpilot.ai_jobs WHERE organization_id=$1 AND idempotency_key=$2",
        [organizationId, key],
      );
      if (existing.rows[0])
        return { job: map(existing.rows[0]), created: false };
      const requestId = uuidv7();
      await c.query(
        "INSERT INTO rfpilot.ai_test_requests(id,organization_id,actor_external_user_id,operation,fixture,evidence_references,idempotency_key,correlation_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        [
          requestId,
          organizationId,
          input.actorUserMongoId,
          input.operation,
          input.fixture,
          JSON.stringify(input.evidenceReferences),
          input.idempotencyKey,
          input.correlationId,
        ],
      );
      const id = uuidv7();
      const created = await c.query<Row>(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,job_type,status,idempotency_key,input_reference,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,'ai_gateway_test','queued',$3,$4,2,$5,$6) RETURNING *",
        [
          id,
          organizationId,
          key,
          requestId,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      const payload: QueueMessage = {
        jobId: id,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "ai_gateway_test",
        inputReference: requestId,
        inputVersion: null,
        correlationId: input.correlationId,
      };
      await c.query(
        "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)",
        [
          uuidv7(),
          organizationId,
          id,
          `job.queued:${id}:1`,
          JSON.stringify(payload),
        ],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.create",
        jobId: id,
        correlationId: input.correlationId,
        metadata: { jobType: "ai_gateway_test" },
      });
      return { job: map(created.rows[0]), created: true };
    });
  },
  createKnowledgeParse(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const document = await c.query<{
        id: string;
        sha256: string | null;
        status: string;
      }>(
        "SELECT id,sha256,status FROM rfpilot.knowledge_import_documents WHERE id=$1",
        [input.documentId],
      );
      if (!document.rows[0])
        throw new DurableJobError(
          "KNOWLEDGE_DOCUMENT_NOT_FOUND",
          "Knowledge document was not found.",
          404,
        );
      if (!["parse_queued", "failed"].includes(document.rows[0].status))
        throw new DurableJobError(
          "INVALID_KNOWLEDGE_DOCUMENT_STATE",
          "Knowledge document is not ready to parse.",
          409,
        );
      const key = `knowledge_parse:${input.idempotencyKey}`;
      const existing = await c.query<Row>(
        "SELECT * FROM rfpilot.ai_jobs WHERE organization_id=$1 AND idempotency_key=$2",
        [organizationId, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].input_reference !== input.documentId)
          throw new DurableJobError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for different input.",
            409,
          );
        return { job: map(existing.rows[0]), created: false };
      }
      const id = uuidv7();
      const created = await c.query<Row>(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,job_type,status,idempotency_key,input_reference,input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,'knowledge_parse','queued',$3,$4,'deterministic-v1',$5,3,$6,$7) RETURNING *",
        [
          id,
          organizationId,
          key,
          input.documentId,
          document.rows[0].sha256,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      const payload: QueueMessage = {
        jobId: id,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "knowledge_parse",
        inputReference: input.documentId,
        inputVersion: "deterministic-v1",
        correlationId: input.correlationId,
      };
      await c.query(
        "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)",
        [
          uuidv7(),
          organizationId,
          id,
          `job.queued:${id}:1`,
          JSON.stringify(payload),
        ],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.create",
        jobId: id,
        correlationId: input.correlationId,
        metadata: { jobType: "knowledge_parse" },
      });
      return { job: map(created.rows[0]), created: true };
    });
  },
  createKnowledgeIndex(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const release = await c.query<{
        id: string;
        state: string;
        classification: string;
      }>(
        `SELECT r.id,r.state,b.classification FROM rfpilot.knowledge_releases r JOIN rfpilot.knowledge_import_batches b ON b.id=r.batch_id WHERE r.id=$1 AND r.state='active' AND r.effective_at<=now() AND (r.expires_at IS NULL OR r.expires_at>now())`,
        [input.releaseId],
      );
      if (!release.rows[0])
        throw new DurableJobError(
          "RELEASE_NOT_ELIGIBLE",
          "Release is not currently eligible.",
          409,
        );
      if (release.rows[0].classification !== "synthetic")
        throw new DurableJobError(
          "CLASSIFICATION_NOT_ALLOWED",
          "Only synthetic releases may be semantically indexed in Slice 2C.",
          422,
        );
      const key = `knowledge_index_release:${input.idempotencyKey}`,
        existing = await c.query<Row>(
          "SELECT * FROM rfpilot.ai_jobs WHERE organization_id=$1 AND idempotency_key=$2",
          [organizationId, key],
        );
      if (existing.rows[0]) {
        if (existing.rows[0].input_reference !== input.releaseId)
          throw new DurableJobError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for different input.",
            409,
          );
        return { job: map(existing.rows[0]), created: false };
      }
      const id = uuidv7();
      const created = await c.query<Row>(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,job_type,status,idempotency_key,input_reference,input_version,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,'knowledge_index_release','queued',$3,$4,'test-synthetic-v1',3,$5,$6) RETURNING *",
        [
          id,
          organizationId,
          key,
          input.releaseId,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      const p = await c.query<{
        id: string;
        embedding_model_release_id: string;
      }>(
        `SELECT id,embedding_model_release_id FROM rfpilot.knowledge_retrieval_policies WHERE environment='test' AND purpose='retrieval_test' AND classification='synthetic' AND active AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) ORDER BY approved_at DESC LIMIT 1`,
      );
      if (!p.rows[0])
        throw new DurableJobError(
          "RETRIEVAL_POLICY_NOT_FOUND",
          "No active Slice 2C retrieval policy is available.",
          503,
        );
      const fragments = await c.query<{ count: string }>(
        "SELECT count(*) count FROM rfpilot.knowledge_release_fragments WHERE release_id=$1",
        [input.releaseId],
      );
      await c.query(
        "INSERT INTO rfpilot.knowledge_index_runs(id,organization_id,release_id,policy_id,embedding_model_release_id,job_id,status,fragment_count) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) ON CONFLICT(release_id,policy_id) DO UPDATE SET job_id=excluded.job_id,status='queued',fragment_count=excluded.fragment_count,indexed_fragment_count=0,safe_error_code=null,started_at=null,completed_at=null,updated_at=now()",
        [
          uuidv7(),
          organizationId,
          input.releaseId,
          p.rows[0].id,
          p.rows[0].embedding_model_release_id,
          id,
          Number(fragments.rows[0].count),
        ],
      );
      const payload: QueueMessage = {
        jobId: id,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "knowledge_index_release",
        inputReference: input.releaseId,
        inputVersion: "test-synthetic-v1",
        correlationId: input.correlationId,
      };
      await c.query(
        "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)",
        [
          uuidv7(),
          organizationId,
          id,
          `job.queued:${id}:1`,
          JSON.stringify(payload),
        ],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.create",
        jobId: id,
        correlationId: input.correlationId,
        metadata: { jobType: "knowledge_index_release" },
      });
      return { job: map(created.rows[0]), created: true };
    });
  },
  get(org, id) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, org);
      return map(await getRow(c, id));
    });
  },
  list(org, limit) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, org);
      const r = await c.query<Row>(
        "SELECT * FROM rfpilot.ai_jobs ORDER BY created_at DESC LIMIT $1",
        [limit],
      );
      return r.rows.map(map);
    });
  },
  cancel(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const row = await getRow(c, input.jobId, true);
      if (
        ["succeeded", "failed", "cancelled", "dead_letter"].includes(row.status)
      )
        return map(row);
      const immediate = ["queued", "retry_scheduled"].includes(row.status);
      const updated = await c.query<Row>(
        `UPDATE rfpilot.ai_jobs SET cancellation_requested_at=now(),cancelled_by_external_user_id=$2,status=CASE WHEN $3 THEN 'cancelled' ELSE status END,completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,updated_at=now() WHERE id=$1 RETURNING *`,
        [input.jobId, input.actorUserMongoId, immediate],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.cancel",
        jobId: input.jobId,
        correlationId: input.correlationId,
      });
      return map(updated.rows[0]);
    });
  },
  retry(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const row = await getRow(c, input.jobId, true);
      if (!["failed", "dead_letter"].includes(row.status))
        throw new DurableJobError(
          "INVALID_JOB_STATE",
          "Only failed or dead-letter jobs can be retried.",
          409,
        );
      const updated = await c.query<Row>(
        `UPDATE rfpilot.ai_jobs SET status='queued',attempt_count=0,available_at=now(),error_code=null,cancellation_requested_at=null,completed_at=null,updated_at=now() WHERE id=$1 RETURNING *`,
        [input.jobId],
      );
      await c.query(
        "UPDATE rfpilot.job_dead_letters SET operator_status='requeued',recovered_by_external_user_id=$2,recovery_reason=$3,recovered_at=now() WHERE job_id=$1 AND operator_status='open'",
        [input.jobId, input.actorUserMongoId, input.reason],
      );
      const msg = await messageFrom(c, updated.rows[0]);
      await c.query(
        `INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)`,
        [
          uuidv7(),
          organizationId,
          input.jobId,
          `job.requeued:${input.jobId}:${uuidv7()}`,
          JSON.stringify(msg),
        ],
      );
      await audit(c, {
        organizationId,
        actor: input.actorUserMongoId,
        action: "job.retry",
        jobId: input.jobId,
        correlationId: input.correlationId,
        metadata: { reason: input.reason },
      });
      return map(updated.rows[0]);
    });
  },
  claim(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.message.organizationMongoId);
      const row = await getRow(c, input.message.jobId, true);
      if (row.status === "cancelled" || row.cancellation_requested_at)
        return { job: map(row), cancelled: true };
      if (!["queued", "retry_scheduled"].includes(row.status))
        return { job: map(row), cancelled: row.status !== "running" };
      const lease = new Date(Date.now() + input.leaseSeconds * 1000);
      const updated = await c.query<Row>(
        `UPDATE rfpilot.ai_jobs SET status='running',attempt_count=$2,started_at=COALESCE(started_at,now()),lease_owner=$3,lease_expires_at=$4,progress_stage='running',updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, input.attempt, input.workerId, lease],
      );
      await c.query(
        `INSERT INTO rfpilot.job_attempts(id,organization_id,job_id,attempt_number,worker_id,status,lease_expires_at,heartbeat_at) VALUES($1,$2,$3,$4,$5,'running',$6,now()) ON CONFLICT(job_id,attempt_number) DO UPDATE SET worker_id=EXCLUDED.worker_id,status='running',lease_expires_at=EXCLUDED.lease_expires_at,heartbeat_at=now(),completed_at=null`,
        [
          uuidv7(),
          organizationId,
          row.id,
          input.attempt,
          input.workerId,
          lease,
        ],
      );
      return { job: map(updated.rows[0]), cancelled: false };
    });
  },
  heartbeat(input) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.message.organizationMongoId);
      const lease = new Date(Date.now() + input.leaseSeconds * 1000);
      const r = await c.query(
        `UPDATE rfpilot.ai_jobs SET lease_expires_at=$3,progress=$4,progress_stage=$5,updated_at=now() WHERE id=$1 AND status='running' AND lease_owner=$2 AND cancellation_requested_at IS NULL`,
        [
          input.message.jobId,
          input.workerId,
          lease,
          input.progress,
          input.stage,
        ],
      );
      await c.query(
        "UPDATE rfpilot.job_attempts SET lease_expires_at=$3,heartbeat_at=now() WHERE job_id=$1 AND worker_id=$2 AND status='running'",
        [input.message.jobId, input.workerId, lease],
      );
      return Boolean(r.rowCount);
    });
  },
  complete(input) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.message.organizationMongoId);
      const row = await getRow(c, input.message.jobId, true);
      if (row.status === "succeeded") return map(row);
      if (row.status !== "running" || row.lease_owner !== input.workerId)
        throw new DurableJobError(
          "JOB_LEASE_LOST",
          "Worker no longer owns this job.",
          409,
        );
      if (row.cancellation_requested_at) {
        const cancelled = await c.query<Row>(
          "UPDATE rfpilot.ai_jobs SET status='cancelled',completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now() WHERE id=$1 RETURNING *",
          [row.id],
        );
        await c.query(
          "UPDATE rfpilot.job_attempts SET status='cancelled',retry_decision='cancel',completed_at=now() WHERE job_id=$1 AND attempt_number=$2",
          [row.id, input.attempt],
        );
        return map(cancelled.rows[0]);
      }
      const updated = await c.query<Row>(
        `UPDATE rfpilot.ai_jobs SET status='succeeded',progress=100,progress_stage='completed',result_reference=$2,completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, input.resultReference ?? input.message.inputReference],
      );
      await c.query(
        "UPDATE rfpilot.job_attempts SET status='succeeded',retry_decision='fail',completed_at=now() WHERE job_id=$1 AND attempt_number=$2",
        [row.id, input.attempt],
      );
      return map(updated.rows[0]);
    });
  },
  fail(input) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.message.organizationMongoId);
      const row = await getRow(c, input.message.jobId, true);
      if (row.status !== "running") return map(row);
      // row.max_attempts was written at creation and then ignored here in
      // favour of the worker's global JOB_MAX_ATTEMPTS, so a 2-attempt job
      // retried 5 times — and for vendor analysis every extra attempt is a
      // billed provider call. BullMQ may still deliver further attempts;
      // claim() rejects them once the row is dead_letter, so no additional
      // provider call is made.
      const exhausted = input.attempt >= attemptBudget(row.max_attempts, input.maxAttempts);
      const status = input.retryable
        ? exhausted
          ? "dead_letter"
          : "retry_scheduled"
        : "failed";
      const updated = await c.query<Row>(
        `UPDATE rfpilot.ai_jobs SET status=$2,error_code=$3,available_at=now(),completed_at=CASE WHEN $2 IN ('failed','dead_letter') THEN now() ELSE null END,lease_owner=null,lease_expires_at=null,updated_at=now() WHERE id=$1 RETURNING *`,
        [row.id, status, input.diagnosticCode],
      );
      await c.query(
        "UPDATE rfpilot.job_attempts SET status=$3,diagnostic_code=$4,retry_decision=$5,completed_at=now() WHERE job_id=$1 AND attempt_number=$2",
        [
          row.id,
          input.attempt,
          input.retryable ? "retryable_failure" : "permanent_failure",
          input.diagnosticCode,
          status === "retry_scheduled"
            ? "retry"
            : status === "dead_letter"
              ? "dead_letter"
              : "fail",
        ],
      );
      if (status === "dead_letter")
        await c.query(
          `INSERT INTO rfpilot.job_dead_letters(id,organization_id,job_id,reason_code,last_diagnostic_code) VALUES($1,$2,$3,'ATTEMPTS_EXHAUSTED',$4) ON CONFLICT(job_id,operator_status) DO NOTHING`,
          [uuidv7(), organizationId, row.id, input.diagnosticCode],
        );
      return map(updated.rows[0]);
    });
  },
  /* A dispatcher killed between claiming and marking leaves a row
     'publishing' with a stale locked_at, and no recovery path looked at that
     state — the row was stranded forever. A publish attempt takes
     milliseconds, so any 'publishing' row locked more than 60 seconds ago is
     dead and is reclaimed here; re-publishing one that did reach Redis before
     the crash is safe because publish() dedupes on the BullMQ jobId. */
  claimOutbox(limit, dispatcherId) {
    return withPostgresTransaction(async (c) => {
      const r = await c.query<{ id: string; payload: QueueMessage }>(
        `WITH claimed AS (SELECT id FROM rfpilot.outbox_events WHERE event_type='job.queued' AND ((status IN ('pending','failed') AND available_at<=now()) OR (status='publishing' AND locked_at<now()-interval '60 seconds')) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE rfpilot.outbox_events o SET status='publishing',locked_at=now(),locked_by=$2,attempt_count=attempt_count+1 FROM claimed WHERE o.id=claimed.id RETURNING o.id,o.payload`,
        [limit, dispatcherId],
      );
      return r.rows.map((x) => ({ eventId: x.id, message: x.payload }));
    });
  },
  markOutboxPublished(id) {
    return withPostgresTransaction(async (c) => {
      await c.query(
        "UPDATE rfpilot.outbox_events SET status='published',published_at=now(),locked_at=null,locked_by=null WHERE id=$1",
        [id],
      );
    });
  },
  markOutboxFailed(id, code) {
    return withPostgresTransaction(async (c) => {
      await c.query(
        "UPDATE rfpilot.outbox_events SET status=CASE WHEN attempt_count>=5 THEN 'dead_letter' ELSE 'failed' END,last_error_code=$2,available_at=now()+interval '5 seconds',locked_at=null,locked_by=null WHERE id=$1",
        [id, code],
      );
    });
  },
  /* Reclaim jobs whose worker died mid-execution.
     claim() sets lease_expires_at and heartbeat() extends it, but nothing ever
     read the column: a worker that was killed left its job 'running' forever.
     reconcile() only republishes queued/retry_scheduled, and BullMQ's stalled
     re-delivery is rejected by the heartbeat lease check, so the row was
     unreachable by every recovery path and invisible to operators.
     An expired lease returns the job to retry_scheduled, or dead-letters it
     when its per-type attempt budget is spent — the same terminal rule fail()
     applies, so a stuck job cannot outlive its retry allowance. */
  reapExpiredLeases(limit: number) {
    return withPostgresTransaction(async (c) => {
      const stale = await c.query<Row>(
        `SELECT * FROM rfpilot.ai_jobs
           WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
           ORDER BY lease_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const reaped: Array<{ jobId: string; status: string }> = [];
      for (const row of stale.rows) {
        const exhausted = row.attempt_count >= attemptBudget(row.max_attempts, Number(process.env.JOB_MAX_ATTEMPTS || 5));
        const status = exhausted ? "dead_letter" : "retry_scheduled";
        await c.query(
          `UPDATE rfpilot.ai_jobs SET status=$2,error_code='LEASE_EXPIRED',available_at=now(),
             lease_owner=null,lease_expires_at=null,updated_at=now(),
             completed_at=CASE WHEN $2='dead_letter' THEN now() ELSE null END
           WHERE id=$1`,
          [row.id, status],
        );
        if (exhausted && row.job_type === "vendor_requirement_facts")
          await c.query(
            `UPDATE rfpilot.vendor_intelligence_runs
                SET status='failed',safe_error_code='LEASE_EXPIRED',completed_at=now(),updated_at=now()
              WHERE job_id=$1 AND status<>'succeeded'`,
            [row.id],
          );
        if (exhausted)
          await c.query(
            `INSERT INTO rfpilot.job_dead_letters(id,organization_id,job_id,reason_code,last_diagnostic_code)
             VALUES($1,$2,$3,'LEASE_EXPIRED','worker_lost')
             ON CONFLICT (job_id,operator_status) DO NOTHING`,
            [uuidv7(), row.organization_id, row.id],
          );
        reaped.push({ jobId: row.id, status });
      }
      return reaped;
    });
  },
  /* Open dead letters for an operator. The table was written and requeued by
     id, but nothing listed it, so a dead-lettered job could only be found by
     someone who already knew its id. */
  listDeadLetters(limit: number) {
    return withPostgresTransaction(async (c) => {
      const r = await c.query(
        `SELECT d.id,d.job_id,d.reason_code,d.last_diagnostic_code,d.created_at,
                j.job_type,j.attempt_count,j.max_attempts,j.error_code,j.correlation_id
           FROM rfpilot.job_dead_letters d JOIN rfpilot.ai_jobs j ON j.id=d.job_id
          WHERE d.operator_status='open' ORDER BY d.created_at DESC LIMIT $1`,
        [limit],
      );
      return r.rows;
    });
  },
  reconcile(limit) {
    return withPostgresTransaction(async (c) => {
      const r = await c.query<Row>(
        "SELECT * FROM rfpilot.ai_jobs WHERE status IN ('queued','retry_scheduled') AND available_at<=now() ORDER BY created_at LIMIT $1",
        [limit],
      );
      const messages = [];
      for (const row of r.rows) messages.push(await messageFrom(c, row));
      return messages;
    });
  },
};
