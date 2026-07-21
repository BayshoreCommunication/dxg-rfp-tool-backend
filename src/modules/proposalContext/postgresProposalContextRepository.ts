/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  validateProposalExtractionPatchV1,
  formatContractErrors,
} from "../../../contracts/proposal/v1/validators";
import { proposalContextModel } from "./composition";
import { ProposalContextError, type ContextFixture } from "./domain";
import { liveRequirementExtraction, liveMultiSourceRequirementExtraction } from "../liveAi/operations";
import { LIVE_AI_MODEL } from "../liveAi/openAiProvider";
import { postgresDocumentRepository } from "../documentIngestion/postgresDocumentRepository";
import { s3PrivateDocumentStorage } from "../documentIngestion/s3PrivateDocumentStorage";
import { deterministicParser } from "../knowledgeIngestion/deterministicParser";
const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    external,
  ]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0])
    throw new ProposalContextError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
};
const proposal = async (c: PoolClient, id: string, actor: string) => {
  const r = await c.query<{ id: string; external_mongo_id: string }>(
    `SELECT p.id,p.external_mongo_id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'`,
    [id, actor],
  );
  if (!r.rows[0])
    throw new ProposalContextError(
      "PROPOSAL_NOT_FOUND",
      "Proposal was not found.",
      404,
    );
  return r.rows[0];
};
const audit = (
  c: PoolClient,
  v: {
    org: string;
    actor: string;
    action: string;
    id: string;
    correlation: string;
    metadata?: object;
  },
) =>
  c.query(
    "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,'proposal_context_run',$5,'allowed',$6,$7::jsonb)",
    [
      uuidv7(),
      v.org,
      v.actor,
      v.action,
      v.id,
      v.correlation,
      JSON.stringify(v.metadata || {}),
    ],
  );
export const proposalContextRepository = {
  create(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    fixture?: ContextFixture;
    sourceIds?: string[];
    inputChecksum: string;
    idempotencyKey: string;
    correlationId: string;
    live?: boolean;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        p = await proposal(c, input.proposalMongoId, input.actorUserMongoId),
        key = `proposal_context_extract:${input.sourceIds ? "sources:" : input.live ? "live:" : ""}${input.idempotencyKey}`;
      if(input.sourceIds){
        const sources=await c.query<{id:string}>("SELECT id FROM rfpilot.document_sources WHERE id=ANY($1::uuid[]) AND organization_id=$2 AND proposal_reference_id=$3 AND status='ready' AND confidentiality='non_confidential' AND deleted_at IS NULL",[input.sourceIds,org,p.id]);
        if(sources.rowCount!==input.sourceIds.length)throw new ProposalContextError("SOURCE_NOT_ELIGIBLE","Only ready, explicitly non-confidential sources for this proposal may be processed.",409);
      }
      const existing = await c.query<any>(
        `SELECT j.*,r.id run_id FROM rfpilot.ai_jobs j JOIN rfpilot.proposal_context_runs r ON r.job_id=j.id WHERE j.organization_id=$1 AND j.idempotency_key=$2`,
        [org, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].proposal_reference_id !== p.id)
          throw new ProposalContextError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used for another proposal.",
            409,
          );
        return {
          job: existing.rows[0],
          runId: existing.rows[0].run_id,
          created: false,
        };
      }
      const jobId = uuidv7(),
        runId = uuidv7();
      const job = await c.query<any>(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,input_version,input_checksum,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,$3,'proposal_context_extract','queued',$4,$5,'proposal-context.v1',$6,2,$7,$8) RETURNING *",
        [
          jobId,
          org,
          p.id,
          key,
          runId,
          input.inputChecksum,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      await c.query(
        "INSERT INTO rfpilot.proposal_context_runs(id,organization_id,proposal_reference_id,job_id,actor_external_user_id,fixture,source_id,status,input_checksum,correlation_id,retention_until,provider,model) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,now()+($10||' days')::interval,$11,$12)",
        [
          runId,
          org,
          p.id,
          jobId,
          input.actorUserMongoId,
          input.fixture,
          input.sourceIds?.[0] ?? null,
          input.inputChecksum,
          input.correlationId,
          String(Number(process.env.PROPOSAL_CONTEXT_RETENTION_DAYS) || 30),
          input.live ? "openai" : "mock",
          input.live ? LIVE_AI_MODEL : "deterministic-v1",
        ],
      );
      for(let ordinal=0;ordinal<(input.sourceIds?.length??0);ordinal++)await c.query("INSERT INTO rfpilot.proposal_context_run_sources(run_id,organization_id,source_id,ordinal) VALUES($1,$2,$3,$4)",[runId,org,input.sourceIds![ordinal],ordinal]);
      const payload = {
        jobId,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "proposal_context_extract",
        inputReference: runId,
        inputVersion: "proposal-context.v1",
        correlationId: input.correlationId,
      };
      await c.query(
        "INSERT INTO rfpilot.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,idempotency_key,payload) VALUES($1,$2,'ai_job',$3,'job.queued',$4,$5::jsonb)",
        [
          uuidv7(),
          org,
          jobId,
          `job.queued:${jobId}:1`,
          JSON.stringify(payload),
        ],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "proposal.context.create",
        id: runId,
        correlation: input.correlationId,
        metadata: { fixture: input.fixture, sourceCount: input.sourceIds?.length ?? 0 },
      });
      return { job: job.rows[0], runId, created: true };
    });
  },
  execute(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    runId: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      const r = await c.query<any>(
        `SELECT r.*,p.external_mongo_id proposal_mongo_id FROM rfpilot.proposal_context_runs r JOIN rfpilot.proposal_references p ON p.id=r.proposal_reference_id WHERE r.id=$1 FOR UPDATE`,
        [input.runId],
      );
      const run = r.rows[0];
      if (!run)
        throw new ProposalContextError(
          "CONTEXT_RUN_UNAVAILABLE",
          "Context run was not found.",
          404,
        );
      if (run.status === "succeeded") return { resultReference: run.id };
      if (run.provider !== "openai" && (
        proposalContextModel.provider !== "mock" ||
        proposalContextModel.model !== "deterministic-v1"
      ))
        throw new ProposalContextError(
          "CONTEXT_POLICY_NOT_FOUND",
          "The approved proposal context provider is unavailable.",
          403,
        );
      await c.query(
        "UPDATE rfpilot.proposal_context_runs SET status='running',started_at=now(),updated_at=now() WHERE id=$1",
        [run.id],
      );
      let live=null;
      if(run.provider==="openai"&&run.source_id){
        const linked=await c.query<{source_id:string}>("SELECT source_id FROM rfpilot.proposal_context_run_sources WHERE run_id=$1 ORDER BY ordinal",[run.id]),sourceIds=linked.rows.length?linked.rows.map(x=>x.source_id):[run.source_id],sources=[];
        for(const sourceId of sourceIds){const source=await postgresDocumentRepository.get(input.organizationMongoId,sourceId);if(source.proposalMongoId!==run.proposal_mongo_id||source.status!=="ready"||source.confidentiality!=="non_confidential")throw new ProposalContextError("SOURCE_NOT_ELIGIBLE","A selected source is no longer eligible for live AI processing.",409);const object=await s3PrivateDocumentStorage.read({objectKey:source.objectKey,maxBytes:Number(process.env.DOCUMENT_MAX_FILE_BYTES||50*1024*1024)}),parsed=await deterministicParser.parse(object.bytes,source.mimeType);sources.push({sourceId,fragments:parsed.fragments});}
        live=await liveMultiSourceRequirementExtraction(run.proposal_mongo_id,sources,{runType:"proposal_context",runId:run.id,organizationId:run.organization_id});
      }else if(run.provider==="openai")live=await liveRequirementExtraction(run.proposal_mongo_id,run.fixture,{runType:"proposal_context",runId:run.id,organizationId:run.organization_id});
      const candidate = live?.candidate ?? proposalContextModel.extract(run.proposal_mongo_id, run.fixture);
      if ("invalid" in candidate)
        throw new ProposalContextError(
          "INVALID_CANDIDATE_PATCH",
          "Mock candidate is intentionally invalid.",
          422,
        );
      if (!validateProposalExtractionPatchV1(candidate.patch))
        throw new ProposalContextError(
          "INVALID_CANDIDATE_PATCH",
          formatContractErrors(validateProposalExtractionPatchV1.errors)
            .map((x) => x.message)
            .join("; "),
          422,
        );
      const evidenceIds = new Map<string, string>();
      for (let i = 0; i < candidate.evidence.length; i++) {
        const e = candidate.evidence[i];
        evidenceIds.set(e.fragmentId, e.id);
        await c.query(
          "INSERT INTO rfpilot.proposal_context_evidence(id,organization_id,run_id,source_version_id,fragment_id,locator,content_checksum,ordinal) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
          [
            e.id,
            org,
            run.id,
            e.sourceVersionId,
            e.fragmentId,
            JSON.stringify(e.locator),
            e.contentChecksum,
            i,
          ],
        );
      }
      for (let i = 0; i < candidate.patch.candidates.length; i++) {
        const x = candidate.patch.candidates[i],
          ids = x.evidence
            .map((e) => evidenceIds.get(e.fragmentId))
            .filter(Boolean);
        if (!ids.length)
          throw new ProposalContextError(
            "MISSING_CANDIDATE_EVIDENCE",
            "Candidate evidence is missing.",
            422,
          );
        await c.query(
          "INSERT INTO rfpilot.proposal_context_operations(id,organization_id,run_id,ordinal,operation,path,value,confidence,evidence_ids) VALUES($1,$2,$3,$4,'add',$5,$6::jsonb,$7,$8::uuid[])",
          [
            uuidv7(),
            org,
            run.id,
            i,
            x.path,
            JSON.stringify(x.value),
            x.confidence,
            ids,
          ],
        );
      }
      for (let i = 0; i < candidate.issues.length; i++) {
        const x = candidate.issues[i];
        await c.query(
          "INSERT INTO rfpilot.proposal_context_issues(id,organization_id,run_id,ordinal,code,severity,paths) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [uuidv7(), org, run.id, i, x.code, x.severity, x.paths],
        );
      }
      const outputChecksum = crypto
        .createHash("sha256")
        .update(JSON.stringify(candidate.patch))
        .digest("hex");
      await c.query(
        "UPDATE rfpilot.proposal_context_runs SET status='succeeded',output_checksum=$2,operation_count=$3,evidence_count=$4,issue_count=$5,input_tokens=$6,output_tokens=$7,provider_request_id=$8,completed_at=now(),updated_at=now() WHERE id=$1",
        [
          run.id,
          outputChecksum,
          candidate.patch.candidates.length,
          candidate.evidence.length,
          candidate.issues.length,
          live?.usage.inputTokens ?? null,
          live?.usage.outputTokens ?? null,
          live?.usage.providerRequestId ?? null,
        ],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "proposal.context.complete",
        id: run.id,
        correlation: input.correlationId,
        metadata: {
          operationCount: candidate.patch.candidates.length,
          evidenceCount: candidate.evidence.length,
          issueCount: candidate.issues.length,
          provider: run.provider,
          model: run.model,
        },
      });
      return { resultReference: run.id };
    });
  },
  markFailed(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    runId: string;
    correlationId: string;
    code: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      await c.query(
        "UPDATE rfpilot.proposal_context_runs SET status='failed',safe_error_code=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status<>'succeeded'",
        [input.runId, input.code],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "proposal.context.fail",
        id: input.runId,
        correlation: input.correlationId,
        metadata: { code: input.code },
      });
    });
  },
  read(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const p = await proposal(
        c,
        input.proposalMongoId,
        input.actorUserMongoId,
      );
      const run = await c.query<any>(
        "SELECT * FROM rfpilot.proposal_context_runs WHERE id=$1 AND proposal_reference_id=$2",
        [input.runId, p.id],
      );
      if (!run.rows[0])
        throw new ProposalContextError(
          "CONTEXT_RUN_UNAVAILABLE",
          "Context run was not found.",
          404,
        );
      const operations = await c.query<any>(
          "SELECT ordinal,operation,path,value,confidence,evidence_ids FROM rfpilot.proposal_context_operations WHERE run_id=$1 ORDER BY ordinal",
          [input.runId],
        ),
        evidence = await c.query<any>(
          "SELECT id,source_version_id,fragment_id,locator,content_checksum,ordinal FROM rfpilot.proposal_context_evidence WHERE run_id=$1 ORDER BY ordinal",
          [input.runId],
        ),
        issues = await c.query<any>(
          "SELECT code,severity,paths,ordinal FROM rfpilot.proposal_context_issues WHERE run_id=$1 ORDER BY ordinal",
          [input.runId],
        );
      return {
        run: run.rows[0],
        operations: operations.rows,
        evidence: evidence.rows,
        issues: issues.rows,
        proposalMutation: false,
      };
    });
  },
};
