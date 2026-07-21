/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import { ProposalDraftError } from "./domain";
import { deterministicProposalDraft } from "./deterministicDraftProvider";
import { liveProposalDraft } from "../liveAi/operations";
import { LIVE_AI_MODEL } from "../liveAi/openAiProvider";
import { knowledgeRetrievalRepository } from "../knowledgeRetrieval/postgresKnowledgeRetrievalRepository";
import { retrievalEnabled } from "../knowledgeRetrieval/domain";
const tenant = async (c: PoolClient, x: string) => {
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
      x,
    ]);
    const r = await c.query<{ id: string }>(
      "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
      [x],
    );
    if (!r.rows[0])
      throw new ProposalDraftError(
        "ORGANIZATION_NOT_READY",
        "Organization unavailable.",
        503,
      );
    await c.query("SELECT set_config('app.organization_id',$1,true)", [
      r.rows[0].id,
    ]);
    return r.rows[0].id;
  },
  owned = async (c: PoolClient, p: string, u: string) => {
    const r = await c.query<any>(
      "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2",
      [p, u],
    );
    if (!r.rows[0])
      throw new ProposalDraftError(
        "PROPOSAL_NOT_FOUND",
        "Proposal was not found.",
        404,
      );
    return r.rows[0].id;
  },
  hash = (v: unknown) =>
    crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const proposalDraftRepository = {
  create(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    expectedProposalVersion: number;
    fixture: string;
    idempotencyKey: string;
    correlationId: string;
    live?: boolean;
    sectionScope?: string | null;
    parentRunId?: string | null;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        p = await owned(c, input.proposalMongoId, input.actorUserMongoId),
        key = `proposal_draft:${input.live ? "live:" : ""}${input.idempotencyKey}`,
        old = await c.query<any>(
          "SELECT r.*,j.status job_status FROM rfpilot.proposal_draft_runs r JOIN rfpilot.ai_jobs j ON j.id=r.job_id WHERE r.organization_id=$1 AND r.idempotency_key=$2",
          [org, key],
        );
      if (old.rows[0]) return { run: old.rows[0], created: false };
      const runId = uuidv7(),
        jobId = uuidv7();
      await c.query(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,input_version,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,$3,'proposal_draft_generate','queued',$4,$5,'proposal-draft.v1',2,$6,$7)",
        [
          jobId,
          org,
          p,
          key,
          runId,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      const run = await c.query<any>(
        "INSERT INTO rfpilot.proposal_draft_runs(id,organization_id,proposal_reference_id,job_id,actor_external_user_id,status,expected_proposal_version,fixture,idempotency_key,correlation_id,retention_until,provider,model,section_scope,parent_run_id) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,now()+interval '30 days',$10,$11,$12,$13) RETURNING *",
        [
          runId,
          org,
          p,
          jobId,
          input.actorUserMongoId,
          input.expectedProposalVersion,
          input.fixture,
          key,
          input.correlationId,
          input.live ? "openai" : "mock",
          input.live ? LIVE_AI_MODEL : "deterministic-v1",
          input.sectionScope ?? null,
          input.parentRunId ?? null,
        ],
      );
      const payload = {
        jobId,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "proposal_draft_generate",
        inputReference: runId,
        inputVersion: "proposal-draft.v1",
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
      return {
        run: { ...run.rows[0], job_id: jobId, job_status: "queued" },
        created: true,
      };
    });
  },
  async execute(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    runId: string;
  }) {
    const meta = await withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const r = await c.query<any>(
        `SELECT r.*,p.external_mongo_id proposal FROM rfpilot.proposal_draft_runs r JOIN rfpilot.proposal_references p ON p.id=r.proposal_reference_id WHERE r.id=$1 FOR UPDATE`,
        [input.runId],
      );
      if (!r.rows[0])
        throw new ProposalDraftError(
          "DRAFT_RUN_NOT_FOUND",
          "Draft run was not found.",
          404,
        );
      if (r.rows[0].status === "succeeded") return r.rows[0];
      await c.query(
        "UPDATE rfpilot.proposal_draft_runs SET status='running',updated_at=now() WHERE id=$1",
        [input.runId],
      );
      return r.rows[0];
    });
    if (meta.status === "succeeded") return { resultReference: input.runId };
    const proposal = await Proposal.findOne({
      _id: meta.proposal,
      userId: input.actorUserMongoId,
      organizationId: input.organizationMongoId,
    })
      .select("version status isDraft isArchived event venueSchedule")
      .lean<any>();
    const version = Number(proposal?.version || 1);
    if (
      !proposal ||
      proposal.status !== "unsubmitted" ||
      proposal.isDraft !== true ||
      proposal.isArchived === true ||
      version !== meta.expected_proposal_version
    ) {
      await this.fail({
        organizationMongoId: input.organizationMongoId,
        runId: input.runId,
        code: "PROPOSAL_VERSION_OR_LIFECYCLE_CONFLICT",
        status: "conflict",
      });
      throw new ProposalDraftError(
        "PROPOSAL_VERSION_CONFLICT",
        "Proposal changed or is not an eligible draft.",
        409,
      );
    }
    const sectionScope = meta.section_scope || null;
    // Governed knowledge grounding: approved fragments join the evidence set as
    // cited /knowledge/ entries. Retrieval failure never fails the draft.
    let knowledgeEvidence: Array<{ id: string; text: string }> = [];
    if (meta.provider === "openai" && process.env.KNOWLEDGE_IN_DRAFT_ENABLED === "true" && retrievalEnabled()) {
      try {
        const query = [proposal?.event?.eventName, proposal?.event?.eventFormat, proposal?.event?.eventObjectives]
          .filter((value: unknown) => typeof value === "string" && value)
          .join(" ")
          .slice(0, 300);
        if (query.trim().length >= 2) {
          const retrieved = await knowledgeRetrievalRepository.retrieve({
            organizationMongoId: input.organizationMongoId,
            actorUserMongoId: input.actorUserMongoId,
            fixture: "free_text",
            query,
            filters: { sourceTypes: [], market: null, currency: null },
            limit: 5,
            idempotencyKey: `draft-knowledge:${meta.id}`,
            correlationId: meta.correlation_id,
          });
          knowledgeEvidence = retrieved.results.map((item: any) => ({
            id: `/knowledge/${item.releaseId}/${item.fragmentId}`,
            text: String(item.content).slice(0, 2000),
          }));
        }
      } catch {
        knowledgeEvidence = [];
      }
    }
    const live = meta.provider === "openai" ? await liveProposalDraft(proposal, { runType: "proposal_draft", runId: meta.id, organizationId: meta.organization_id }, sectionScope, knowledgeEvidence) : null;
    const generated = live?.draft ?? deterministicProposalDraft(proposal);
    // A scoped regeneration persists only the requested section; gaps are kept
    // when they reference the scoped section or the run produced no content.
    const output = sectionScope
      ? { sections: generated.sections.filter((s) => s.key === sectionScope), gaps: generated.gaps }
      : generated;
    const paragraphCount = output.sections.reduce(
        (n, s) => n + s.paragraphs.length,
        0,
      ),
      citationCount = output.sections.reduce(
        (n, s) =>
          n + s.paragraphs.reduce((m, p) => m + p.evidencePaths.length, 0),
        0,
      );
    await withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      for (let i = 0; i < output.sections.length; i++) {
        const s = output.sections[i],
          sid = uuidv7();
        await c.query(
          "INSERT INTO rfpilot.proposal_draft_sections(id,organization_id,run_id,ordinal,key,heading) VALUES($1,$2,$3,$4,$5,$6)",
          [sid, org, input.runId, i, s.key, s.heading],
        );
        for (let j = 0; j < s.paragraphs.length; j++) {
          const p = s.paragraphs[j],
            pid = uuidv7();
          await c.query(
            "INSERT INTO rfpilot.proposal_draft_paragraphs(id,organization_id,run_id,section_id,ordinal,text,text_checksum) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [pid, org, input.runId, sid, j, p.text, hash(p.text)],
          );
          for (const path of p.evidencePaths)
            await c.query(
              "INSERT INTO rfpilot.proposal_draft_citations(id,organization_id,run_id,paragraph_id,canonical_path,value_checksum) VALUES($1,$2,$3,$4,$5,$6)",
              [uuidv7(), org, input.runId, pid, path, hash(path)],
            );
        }
      }
      for (let i = 0; i < output.gaps.length; i++)
        await c.query(
          "INSERT INTO rfpilot.proposal_draft_gaps(id,organization_id,run_id,ordinal,code,paths) VALUES($1,$2,$3,$4,$5,$6)",
          [
            uuidv7(),
            org,
            input.runId,
            i,
            output.gaps[i].code,
            output.gaps[i].paths,
          ],
        );
      await c.query(
        "UPDATE rfpilot.proposal_draft_runs SET status='succeeded',output_checksum=$2,section_count=$3,paragraph_count=$4,citation_count=$5,gap_count=$6,input_tokens=$7,output_tokens=$8,provider_request_id=$9,completed_at=now(),updated_at=now() WHERE id=$1",
        [
          input.runId,
          hash(output),
          output.sections.length,
          paragraphCount,
          citationCount,
          output.gaps.length,
          live?.usage.inputTokens ?? null,
          live?.usage.outputTokens ?? null,
          live?.usage.providerRequestId ?? null,
        ],
      );
    });
    return { resultReference: input.runId };
  },
  fail(input: {
    organizationMongoId: string;
    runId: string;
    code: string;
    status: "conflict" | "failed";
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      await c.query(
        "UPDATE rfpilot.proposal_draft_runs SET status=$2,safe_error_code=$3,completed_at=now(),updated_at=now() WHERE id=$1",
        [input.runId, input.status, input.code],
      );
    });
  },
  read(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId?: string;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const p = await owned(c, input.proposalMongoId, input.actorUserMongoId),
        run = await c.query<any>(
          `SELECT * FROM rfpilot.proposal_draft_runs WHERE proposal_reference_id=$1 ${input.runId ? "AND id=$2" : "AND status='succeeded' AND section_scope IS NULL AND retention_until>now() ORDER BY created_at DESC LIMIT 1"}`,
          [p, ...(input.runId ? [input.runId] : [])],
        );
      if (!run.rows[0])
        throw new ProposalDraftError(
          "DRAFT_RUN_NOT_FOUND",
          "Draft run was not found.",
          404,
        );
      const sections = await c.query<any>(
          `SELECT s.id,s.key,s.heading,s.ordinal,coalesce(json_agg(json_build_object('text',p.text,'citations',(SELECT json_agg(c.canonical_path ORDER BY c.canonical_path) FROM rfpilot.proposal_draft_citations c WHERE c.paragraph_id=p.id)) ORDER BY p.ordinal) FILTER(WHERE p.id IS NOT NULL),'[]') paragraphs FROM rfpilot.proposal_draft_sections s LEFT JOIN rfpilot.proposal_draft_paragraphs p ON p.section_id=s.id WHERE s.run_id=$1 GROUP BY s.id ORDER BY s.ordinal`,
          [run.rows[0].id],
        ),
        gaps = await c.query<any>(
          "SELECT code,paths,ordinal FROM rfpilot.proposal_draft_gaps WHERE run_id=$1 ORDER BY ordinal",
          [run.rows[0].id],
        ),
        decisions = await c.query<any>(
          "SELECT section_key,decision,reason,updated_at FROM rfpilot.proposal_draft_section_decisions WHERE run_id=$1",
          [run.rows[0].id],
        ),
        regenerations = await c.query<any>(
          "SELECT id,section_scope,status,created_at FROM rfpilot.proposal_draft_runs WHERE parent_run_id=$1 ORDER BY created_at DESC",
          [run.rows[0].id],
        );
      const decisionBySection = new Map<string, any>(decisions.rows.map((d: any) => [d.section_key, d]));
      return {
        run: run.rows[0],
        sections: sections.rows.map((section: any) => ({
          ...section,
          decision: decisionBySection.get(section.key)?.decision ?? null,
          decisionReason: decisionBySection.get(section.key)?.reason ?? null,
        })),
        gaps: gaps.rows,
        regenerations: regenerations.rows,
        proposalMutation: false,
      };
    });
  },
  decideSection(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId: string;
    sectionKey: string;
    decision: "accepted" | "rejected";
    reason: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      const p = await owned(c, input.proposalMongoId, input.actorUserMongoId);
      const run = await c.query<any>(
        "SELECT id,status FROM rfpilot.proposal_draft_runs WHERE id=$1 AND proposal_reference_id=$2 FOR UPDATE",
        [input.runId, p],
      );
      if (!run.rows[0]) throw new ProposalDraftError("DRAFT_RUN_NOT_FOUND", "Draft run was not found.", 404);
      if (run.rows[0].status !== "succeeded")
        throw new ProposalDraftError("DRAFT_RUN_NOT_REVIEWABLE", "Only completed drafts can be reviewed.", 409);
      const section = await c.query<any>(
        "SELECT id FROM rfpilot.proposal_draft_sections WHERE run_id=$1 AND key=$2",
        [input.runId, input.sectionKey],
      );
      if (!section.rows[0]) throw new ProposalDraftError("INVALID_SECTION_KEY", "Draft section was not found.", 404);
      const result = await c.query<any>(
        `INSERT INTO rfpilot.proposal_draft_section_decisions(id,organization_id,run_id,section_key,decision,decided_by_external_user_id,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(run_id,section_key) DO UPDATE SET decision=EXCLUDED.decision,reason=EXCLUDED.reason,decided_by_external_user_id=EXCLUDED.decided_by_external_user_id,updated_at=now()
         RETURNING section_key,decision,reason,updated_at`,
        [uuidv7(), org, input.runId, input.sectionKey, input.decision, input.actorUserMongoId, input.reason],
      );
      await c.query(
        "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'draft_section_decided','proposal_draft_run',$4,'allowed',$5,$6::jsonb)",
        [uuidv7(), org, input.actorUserMongoId, input.runId, input.correlationId, JSON.stringify({ sectionKey: input.sectionKey, outcome: input.decision })],
      );
      return result.rows[0];
    });
  },
};
