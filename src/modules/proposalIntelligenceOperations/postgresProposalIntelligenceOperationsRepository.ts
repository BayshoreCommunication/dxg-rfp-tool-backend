/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { comparisonChecksum, ComparisonOrchestrationError } from "../comparisonOrchestration/domain";
import { REQUIREMENT_GENERATOR_VERSION } from "../requirementRegistry/generator";

export type OperationsContext = { organizationMongoId: string; actorUserMongoId: string; proposalMongoId: string; correlationId: string };

const tenant = async (client: PoolClient, mongoId: string) => {
  await client.query("SELECT set_config('app.organization_mongo_id',$1,true)", [mongoId]);
  const result = await client.query<{ id: string }>("SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'", [mongoId]);
  if (!result.rows[0]) throw new ComparisonOrchestrationError("ORGANIZATION_NOT_READY", "Organization unavailable.", 503, true);
  await client.query("SELECT set_config('app.organization_id',$1,true)", [result.rows[0].id]);
  return result.rows[0].id;
};

const ownedProposal = async (client: PoolClient, proposalMongoId: string, actorMongoId: string) => {
  const result = await client.query<{ id: string }>(
    `SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id
     WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2`, [proposalMongoId, actorMongoId],
  );
  if (!result.rows[0]) throw new ComparisonOrchestrationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return result.rows[0].id;
};

const ownedRun = async (client: PoolClient, proposalReferenceId: string, runId: string) => {
  const result = await client.query<any>(
    `SELECT r.* FROM rfpilot.comparison_runs r
     JOIN rfpilot.requirement_sets s ON s.id=r.requirement_set_id AND s.generator_version=$3
     WHERE r.id=$1 AND r.proposal_reference_id=$2`,
    [runId, proposalReferenceId, REQUIREMENT_GENERATOR_VERSION],
  );
  if (!result.rows[0]) throw new ComparisonOrchestrationError("COMPARISON_NOT_FOUND", "Comparison was not found.", 404);
  return result.rows[0];
};

const audit = (client: PoolClient, input: OperationsContext, organizationId: string, action: string, runId: string, metadata: Record<string, unknown>) => client.query(
  `INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata)
   VALUES($1,$2,$3,$4,'comparison_run',$5,'allow',$6,$7::jsonb)`,
  [uuidv7(), organizationId, input.actorUserMongoId, action, runId, input.correlationId, JSON.stringify(metadata)],
);

const appendClarificationEvent = (client: PoolClient, input: OperationsContext, organizationId: string, setId: string, eventType: string, idempotencyKey: string, payload: Record<string, unknown>) => client.query(
  `INSERT INTO rfpilot.comparison_clarification_events(id,organization_id,clarification_set_id,event_type,payload,actor_external_user_id,idempotency_key,correlation_id)
   VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
  [uuidv7(), organizationId, setId, eventType, JSON.stringify(payload), input.actorUserMongoId, idempotencyKey, input.correlationId],
);

const mapClarification = (set: any, questions: any[]) => ({
  setId: set.id, setVersion: set.set_version, status: set.status, manifestChecksum: set.manifest_checksum,
  contentChecksum: set.content_checksum, lockVersion: set.lock_version, approvedAt: set.approved_at,
  dispatchRecordedAt: set.dispatch_recorded_at, createdAt: set.created_at, updatedAt: set.updated_at,
  questions: questions.map((row) => ({ questionId: row.id, riskId: row.risk_id, participantId: row.participant_id, vendorLabel: row.vendor_label, question: row.question, disposition: row.disposition, ordinal: row.ordinal })),
});

const loadClarification = async (client: PoolClient, runId: string, setId: string) => {
  const set = await client.query<any>("SELECT * FROM rfpilot.comparison_clarification_sets WHERE id=$1 AND comparison_run_id=$2", [setId, runId]);
  if (!set.rows[0]) throw new ComparisonOrchestrationError("CLARIFICATION_SET_NOT_FOUND", "Clarification set was not found.", 404);
  const questions = await client.query<any>("SELECT * FROM rfpilot.comparison_clarification_questions WHERE clarification_set_id=$1 ORDER BY ordinal", [setId]);
  return { set: set.rows[0], questions: questions.rows };
};

export const proposalIntelligenceOperationsRepository = {
  async listClarifications(input: OperationsContext & { runId: string }) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId); const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId); await ownedRun(client, proposalReferenceId, input.runId);
      const sets = await client.query<any>("SELECT * FROM rfpilot.comparison_clarification_sets WHERE comparison_run_id=$1 ORDER BY set_version DESC", [input.runId]);
      const result = [];
      for (const set of sets.rows) {
        const questions = await client.query<any>("SELECT * FROM rfpilot.comparison_clarification_questions WHERE clarification_set_id=$1 ORDER BY ordinal", [set.id]);
        result.push(mapClarification(set, questions.rows));
      }
      return result;
    });
  },

  async createClarification(input: OperationsContext & { runId: string; idempotencyKey: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      if (!["succeeded", "succeeded_with_warnings"].includes(run.status)) throw new ComparisonOrchestrationError("COMPARISON_NOT_READY", "Complete the comparison before preparing clarifications.", 409);
      const operationKey = `clarification:create:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT clarification_set_id FROM rfpilot.comparison_clarification_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) { const value = await loadClarification(client, run.id, prior.rows[0].clarification_set_id); return { ...mapClarification(value.set, value.questions), created: false }; }
      const source = await client.query<any>(
        `SELECT p.id participant_id,p.vendor_label,r.id risk_id,c.question
         FROM rfpilot.comparison_participants p JOIN rfpilot.evaluation_risks r ON r.evaluation_run_id=p.evaluation_run_id
         JOIN rfpilot.clarification_candidates c ON c.risk_id=r.id
         WHERE p.comparison_run_id=$1 ORDER BY p.ordinal,c.ordinal`, [run.id],
      );
      if (!source.rows.length) throw new ComparisonOrchestrationError("CLARIFICATION_QUESTIONS_EMPTY", "No persisted clarification candidates are available for this run.", 409);
      const manifest = await client.query<any>("SELECT content_checksum FROM rfpilot.comparison_manifests WHERE comparison_run_id=$1", [run.id]);
      const version = await client.query<{ next: number }>("SELECT coalesce(max(set_version),0)::int+1 next FROM rfpilot.comparison_clarification_sets WHERE comparison_run_id=$1", [run.id]);
      const setId = uuidv7(), contentChecksum = comparisonChecksum(source.rows.map((row) => ({ riskId: row.risk_id, participantId: row.participant_id, question: row.question, disposition: "included" })));
      await client.query(
        `INSERT INTO rfpilot.comparison_clarification_sets(id,organization_id,comparison_run_id,set_version,manifest_checksum,content_checksum,created_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [setId, organizationId, run.id, version.rows[0].next, manifest.rows[0].content_checksum, contentChecksum, input.actorUserMongoId],
      );
      for (let ordinal = 0; ordinal < source.rows.length; ordinal += 1) {
        const row = source.rows[ordinal];
        await client.query(
          `INSERT INTO rfpilot.comparison_clarification_questions(id,organization_id,clarification_set_id,risk_id,participant_id,vendor_label,question,ordinal)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uuidv7(), organizationId, setId, row.risk_id, row.participant_id, row.vendor_label, row.question, ordinal],
        );
      }
      await appendClarificationEvent(client, input, organizationId, setId, "created", operationKey, { questionCount: source.rows.length, contentChecksum });
      await audit(client, input, organizationId, "comparison.clarification.created", run.id, { setId, setVersion: version.rows[0].next, questionCount: source.rows.length, contentChecksum });
      const value = await loadClarification(client, run.id, setId); return { ...mapClarification(value.set, value.questions), created: true };
    });
  },

  async updateClarificationQuestion(input: OperationsContext & { runId: string; setId: string; questionId: string; question: string; disposition: "included" | "excluded"; expectedVersion: number; idempotencyKey: string }) {
    const question = input.question.trim();
    if (question.length < 1 || question.length > 1000) throw new ComparisonOrchestrationError("CLARIFICATION_QUESTION_INVALID", "Clarification question must be between 1 and 1,000 characters.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const operationKey = `clarification:update:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT clarification_set_id FROM rfpilot.comparison_clarification_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) { const value = await loadClarification(client, run.id, prior.rows[0].clarification_set_id); return mapClarification(value.set, value.questions); }
      const current = await loadClarification(client, run.id, input.setId);
      if (current.set.status !== "draft") throw new ComparisonOrchestrationError("CLARIFICATION_SET_FROZEN", "Approved clarification sets cannot be edited.", 409);
      if (Number(current.set.lock_version) !== input.expectedVersion) throw new ComparisonOrchestrationError("INPUT_VERSION_CONFLICT", "Clarification set changed. Refresh and try again.", 409);
      if (!current.questions.some((item) => item.id === input.questionId)) throw new ComparisonOrchestrationError("CLARIFICATION_QUESTION_NOT_FOUND", "Clarification question was not found.", 404);
      await client.query("UPDATE rfpilot.comparison_clarification_questions SET question=$2,disposition=$3,updated_at=now() WHERE id=$1", [input.questionId, question, input.disposition]);
      const refreshedQuestions = (await client.query<any>("SELECT * FROM rfpilot.comparison_clarification_questions WHERE clarification_set_id=$1 ORDER BY ordinal", [input.setId])).rows;
      const contentChecksum = comparisonChecksum(refreshedQuestions.map((row) => ({ riskId: row.risk_id, participantId: row.participant_id, question: row.question, disposition: row.disposition })));
      await client.query("UPDATE rfpilot.comparison_clarification_sets SET content_checksum=$2,lock_version=lock_version+1,updated_at=now() WHERE id=$1", [input.setId, contentChecksum]);
      await appendClarificationEvent(client, input, organizationId, input.setId, "question_updated", operationKey, { questionId: input.questionId, disposition: input.disposition, contentChecksum });
      await audit(client, input, organizationId, "comparison.clarification.question_updated", run.id, { setId: input.setId, questionId: input.questionId, disposition: input.disposition, contentChecksum });
      const value = await loadClarification(client, run.id, input.setId); return mapClarification(value.set, value.questions);
    });
  },

  async approveClarification(input: OperationsContext & { runId: string; setId: string; expectedVersion: number; idempotencyKey: string }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const operationKey = `clarification:approve:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT clarification_set_id FROM rfpilot.comparison_clarification_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) { const value = await loadClarification(client, run.id, prior.rows[0].clarification_set_id); return mapClarification(value.set, value.questions); }
      const current = await loadClarification(client, run.id, input.setId);
      if (current.set.status !== "draft") throw new ComparisonOrchestrationError("CLARIFICATION_SET_FROZEN", "Clarification set is already approved.", 409);
      if (Number(current.set.lock_version) !== input.expectedVersion) throw new ComparisonOrchestrationError("INPUT_VERSION_CONFLICT", "Clarification set changed. Refresh and try again.", 409);
      const included = current.questions.filter((item) => item.disposition === "included");
      if (!included.length) throw new ComparisonOrchestrationError("CLARIFICATION_QUESTIONS_EMPTY", "Include at least one question before approval.", 409);
      await client.query("UPDATE rfpilot.comparison_clarification_sets SET status='approved',approved_by_external_user_id=$2,approved_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1", [input.setId, input.actorUserMongoId]);
      await appendClarificationEvent(client, input, organizationId, input.setId, "approved", operationKey, { includedQuestionCount: included.length, contentChecksum: current.set.content_checksum });
      await audit(client, input, organizationId, "comparison.clarification.approved", run.id, { setId: input.setId, includedQuestionCount: included.length, contentChecksum: current.set.content_checksum });
      const value = await loadClarification(client, run.id, input.setId); return mapClarification(value.set, value.questions);
    });
  },

  async recordClarificationDispatch(input: OperationsContext & { runId: string; setId: string; channel: "email_campaign" | "manual"; externalReference: string; recipientCount: number; idempotencyKey: string }) {
    const externalReference = input.externalReference.trim();
    if (externalReference.length < 3 || externalReference.length > 300 || input.recipientCount < 1 || input.recipientCount > 1000) throw new ComparisonOrchestrationError("CLARIFICATION_DISPATCH_INVALID", "Dispatch reference and recipient count are required.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const operationKey = `clarification:dispatch:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT clarification_set_id FROM rfpilot.comparison_clarification_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) { const value = await loadClarification(client, run.id, prior.rows[0].clarification_set_id); return mapClarification(value.set, value.questions); }
      const current = await loadClarification(client, run.id, input.setId);
      if (current.set.status !== "approved") throw new ComparisonOrchestrationError("CLARIFICATION_NOT_APPROVED", "Approve the clarification set before recording dispatch.", 409);
      await client.query("UPDATE rfpilot.comparison_clarification_sets SET status='dispatch_recorded',dispatch_recorded_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1", [input.setId]);
      await appendClarificationEvent(client, input, organizationId, input.setId, "dispatch_recorded", operationKey, { channel: input.channel, externalReference, recipientCount: input.recipientCount });
      await audit(client, input, organizationId, "comparison.clarification.dispatch_recorded", run.id, { setId: input.setId, channel: input.channel, externalReference, recipientCount: input.recipientCount });
      const value = await loadClarification(client, run.id, input.setId); return mapClarification(value.set, value.questions);
    });
  },

  async readAudit(input: OperationsContext & { runId: string }) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId); const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const [manifest, events, exports, clarificationEvents, holdEvents, policy] = await Promise.all([
        client.query<any>("SELECT content_checksum,proposal_version,proposal_checksum,requirement_set_version,requirement_checksum,matrix_version,matrix_checksum,price_visibility,created_at FROM rfpilot.comparison_manifests WHERE comparison_run_id=$1", [run.id]),
        client.query<any>("SELECT id,action,decision,reason,correlation_id,metadata,occurred_at FROM rfpilot.audit_events WHERE target_type='comparison_run' AND target_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 250", [run.id]),
        client.query<any>("SELECT id,report_type,media_type,content_checksum,freshness_state,permission_snapshot,byte_size,created_at FROM rfpilot.comparison_report_exports WHERE comparison_run_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", [run.id]),
        client.query<any>(`SELECT e.id,e.event_type,e.payload,e.created_at,s.id set_id,s.set_version FROM rfpilot.comparison_clarification_events e JOIN rfpilot.comparison_clarification_sets s ON s.id=e.clarification_set_id WHERE s.comparison_run_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 250`, [run.id]),
        client.query<any>("SELECT id,hold_id,action,reason,created_at FROM rfpilot.proposal_intelligence_legal_hold_events WHERE comparison_run_id=$1 ORDER BY created_at DESC,id DESC", [run.id]),
        client.query<any>("SELECT procurement_record_retention_days,policy_basis,policy_version,version,updated_at FROM rfpilot.proposal_intelligence_retention_policies LIMIT 1"),
      ]);
      return { schemaVersion: "proposal-intelligence-audit.v1", runId: run.id, generatedAt: new Date().toISOString(), freshness: { state: run.freshness_state, reasons: run.stale_reasons }, manifest: manifest.rows[0], events: events.rows, exports: exports.rows, clarificationEvents: clarificationEvents.rows, legalHoldEvents: holdEvents.rows, retentionPolicy: policy.rows[0] ?? { procurement_record_retention_days: 2555, policy_basis: "Default seven-year procurement record retention; organization approval is pending.", policy_version: "proposal-intelligence-retention.v1", version: 0, updated_at: null } };
    });
  },

  async readOperations(input: OperationsContext & { runId: string }) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, input.organizationMongoId); const proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const result = await client.query<any>(
        `SELECT
          (SELECT count(*)::int FROM rfpilot.comparison_report_exports WHERE comparison_run_id=$1) report_export_count,
          (SELECT count(*)::int FROM rfpilot.comparison_decisions WHERE comparison_run_id=$1) decision_count,
          (SELECT count(*)::int FROM rfpilot.comparison_clarification_sets WHERE comparison_run_id=$1) clarification_set_count,
          (SELECT count(*)::int FROM rfpilot.comparison_clarification_sets WHERE comparison_run_id=$1 AND status='approved') approved_clarification_count,
          (SELECT count(*)::int FROM rfpilot.comparison_job_nodes WHERE comparison_run_id=$1 AND status IN('failed','dead_letter')) failed_job_count,
          (SELECT count(*)::int FROM rfpilot.comparison_participants WHERE comparison_run_id=$1 AND warning_count>0) participant_warning_count,
          (SELECT count(*)::int FROM rfpilot.ai_assessments a JOIN rfpilot.comparison_participants p ON p.evaluation_run_id=a.evaluation_run_id WHERE p.comparison_run_id=$1 AND a.needs_human_review) unresolved_review_count,
          (SELECT count(*)::int FROM rfpilot.proposal_intelligence_legal_hold_events h WHERE h.comparison_run_id=$1 AND h.action='placed' AND NOT EXISTS(SELECT 1 FROM rfpilot.proposal_intelligence_legal_hold_events r WHERE r.hold_id=h.hold_id AND r.action='released')) active_legal_hold_count`, [run.id],
      );
      const durationMs = run.completed_at ? Math.max(0, new Date(run.completed_at).getTime() - new Date(run.created_at).getTime()) : null;
      return { schemaVersion: "proposal-intelligence-operations.v1", runId: run.id, status: run.status, progress: Number(run.progress), freshnessState: run.freshness_state, durationMs, ...result.rows[0] };
    });
  },

  async updateRetentionPolicy(input: OperationsContext & { runId: string; retentionDays: number; policyBasis: string; expectedVersion: number }) {
    const policyBasis = input.policyBasis.trim();
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 365 || input.retentionDays > 3650 || policyBasis.length < 20 || policyBasis.length > 2000) throw new ComparisonOrchestrationError("RETENTION_POLICY_INVALID", "Retention policy requires 365-3,650 days and a documented basis.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId);
      const existing = await client.query<any>("SELECT * FROM rfpilot.proposal_intelligence_retention_policies LIMIT 1 FOR UPDATE");
      if (!existing.rows[0]) {
        if (input.expectedVersion !== 0) throw new ComparisonOrchestrationError("INPUT_VERSION_CONFLICT", "Retention policy changed. Refresh and try again.", 409);
        await client.query("INSERT INTO rfpilot.proposal_intelligence_retention_policies(id,organization_id,procurement_record_retention_days,policy_basis,updated_by_external_user_id) VALUES($1,$2,$3,$4,$5)", [uuidv7(), organizationId, input.retentionDays, policyBasis, input.actorUserMongoId]);
      } else {
        if (Number(existing.rows[0].version) !== input.expectedVersion) throw new ComparisonOrchestrationError("INPUT_VERSION_CONFLICT", "Retention policy changed. Refresh and try again.", 409);
        await client.query("UPDATE rfpilot.proposal_intelligence_retention_policies SET procurement_record_retention_days=$2,policy_basis=$3,version=version+1,updated_by_external_user_id=$4,updated_at=now() WHERE id=$1", [existing.rows[0].id, input.retentionDays, policyBasis, input.actorUserMongoId]);
      }
      const policy = (await client.query<any>("SELECT procurement_record_retention_days,policy_basis,policy_version,version,updated_at FROM rfpilot.proposal_intelligence_retention_policies LIMIT 1")).rows[0];
      await audit(client, input, organizationId, "comparison.retention_policy.updated", run.id, { retentionDays: input.retentionDays, policyVersion: policy.policy_version, version: policy.version });
      return policy;
    });
  },

  async placeLegalHold(input: OperationsContext & { runId: string; reason: string; idempotencyKey: string }) {
    const reason = input.reason.trim(); if (reason.length < 20 || reason.length > 2000) throw new ComparisonOrchestrationError("LEGAL_HOLD_REASON_REQUIRED", "Legal hold reason must be between 20 and 2,000 characters.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId), operationKey = `legal-hold:place:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT * FROM rfpilot.proposal_intelligence_legal_hold_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) return { holdId: prior.rows[0].hold_id, created: false };
      const holdId = uuidv7();
      await client.query("INSERT INTO rfpilot.proposal_intelligence_legal_hold_events(id,organization_id,hold_id,comparison_run_id,action,reason,actor_external_user_id,idempotency_key,correlation_id) VALUES($1,$2,$3,$4,'placed',$5,$6,$7,$8)", [uuidv7(), organizationId, holdId, run.id, reason, input.actorUserMongoId, operationKey, input.correlationId]);
      await audit(client, input, organizationId, "comparison.legal_hold.placed", run.id, { holdId }); return { holdId, created: true };
    });
  },

  async releaseLegalHold(input: OperationsContext & { runId: string; holdId: string; reason: string; idempotencyKey: string }) {
    const reason = input.reason.trim(); if (reason.length < 20 || reason.length > 2000) throw new ComparisonOrchestrationError("LEGAL_HOLD_REASON_REQUIRED", "Legal hold release reason must be between 20 and 2,000 characters.");
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId), operationKey = `legal-hold:release:${input.idempotencyKey}`;
      const prior = await client.query<any>("SELECT * FROM rfpilot.proposal_intelligence_legal_hold_events WHERE organization_id=$1 AND idempotency_key=$2", [organizationId, operationKey]);
      if (prior.rows[0]) return { holdId: prior.rows[0].hold_id, released: false };
      const placed = await client.query<any>("SELECT * FROM rfpilot.proposal_intelligence_legal_hold_events WHERE comparison_run_id=$1 AND hold_id=$2 AND action='placed'", [run.id, input.holdId]);
      if (!placed.rows[0]) throw new ComparisonOrchestrationError("LEGAL_HOLD_NOT_FOUND", "Legal hold was not found.", 404);
      const released = await client.query<any>("SELECT id FROM rfpilot.proposal_intelligence_legal_hold_events WHERE hold_id=$1 AND action='released'", [input.holdId]);
      if (released.rows[0]) throw new ComparisonOrchestrationError("LEGAL_HOLD_ALREADY_RELEASED", "Legal hold was already released.", 409);
      await client.query("INSERT INTO rfpilot.proposal_intelligence_legal_hold_events(id,organization_id,hold_id,comparison_run_id,action,reason,actor_external_user_id,idempotency_key,correlation_id) VALUES($1,$2,$3,$4,'released',$5,$6,$7,$8)", [uuidv7(), organizationId, input.holdId, run.id, reason, input.actorUserMongoId, operationKey, input.correlationId]);
      await audit(client, input, organizationId, "comparison.legal_hold.released", run.id, { holdId: input.holdId }); return { holdId: input.holdId, released: true };
    });
  },

  async recordReportExport(input: OperationsContext & { runId: string; reportType: string; mediaType: string; manifestChecksum: string; contentChecksum: string; freshnessState: "current" | "stale"; viewCommercial: boolean; byteSize: number }) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(client, input.organizationMongoId), proposalReferenceId = await ownedProposal(client, input.proposalMongoId, input.actorUserMongoId), run = await ownedRun(client, proposalReferenceId, input.runId), exportId = uuidv7();
      await client.query(
        `INSERT INTO rfpilot.comparison_report_exports(id,organization_id,comparison_run_id,report_type,media_type,manifest_checksum,content_checksum,freshness_state,permission_snapshot,byte_size,actor_external_user_id,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [exportId, organizationId, run.id, input.reportType, input.mediaType, input.manifestChecksum, input.contentChecksum, input.freshnessState, JSON.stringify({ viewCommercial: input.viewCommercial }), input.byteSize, input.actorUserMongoId, input.correlationId],
      );
      await audit(client, input, organizationId, "comparison.report.exported", run.id, { exportId, reportType: input.reportType, contentChecksum: input.contentChecksum, freshnessState: input.freshnessState, viewCommercial: input.viewCommercial, byteSize: input.byteSize });
      return { exportId };
    });
  },
};
