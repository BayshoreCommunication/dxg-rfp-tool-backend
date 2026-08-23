/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { AUTO_APPLY_MIN_CONFIDENCE, CandidateApplicationError, type ReviewDecision } from "./domain";
import { normalizeCandidate } from "./canonicalMapping";
import { mongoProposalCandidateMutation } from "./mongoProposalCandidateMutation";
import {
  isRetiredCanonicalProposalWorkflowPath,
  isRetiredProposalWorkflowPath,
} from "../proposals/domain/workflowSections";
import { PROPOSAL_CONTEXT_INPUT_VERSION } from "../proposalContext/domain";

export const requiresOverwriteConfirmation = (
  current: unknown,
  incoming: unknown,
  overwriteConfirmed: boolean,
) =>
  current !== undefined &&
  current !== null &&
  current !== "" &&
  !(typeof current === "string" && current.trim().toLowerCase() === "untitled proposal") &&
  !isDeepStrictEqual(current, incoming) &&
  !overwriteConfirmed;

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [
    external,
  ]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0])
    throw new CandidateApplicationError(
      "ORGANIZATION_NOT_READY",
      "Organization foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
};
const owned = async (c: PoolClient, proposalId: string, actor: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'",
    [proposalId, actor],
  );
  if (!r.rows[0])
    throw new CandidateApplicationError(
      "PROPOSAL_NOT_FOUND",
      "Proposal was not found.",
      404,
    );
  return r.rows[0].id;
};
const run = async (c: PoolClient, id: string, proposalRef: string) => {
  const r = await c.query<any>(
    `SELECT r.* FROM rfpilot.proposal_context_runs r
     JOIN rfpilot.ai_jobs j ON j.id=r.job_id AND j.input_version=$3
     WHERE r.id=$1 AND r.proposal_reference_id=$2 AND r.status='succeeded'`,
    [id, proposalRef, PROPOSAL_CONTEXT_INPUT_VERSION],
  );
  if (!r.rows[0])
    throw new CandidateApplicationError(
      "CONTEXT_RUN_UNAVAILABLE",
      "Completed context run was not found.",
      404,
    );
  return r.rows[0];
};
const checksum = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const candidateApplicationRepository = {
  saveReview(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId: string;
    revision: number;
    decisions: Array<{
      operationId: string;
      decision: ReviewDecision;
      value: unknown;
      reason: string | null;
    }>;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        proposalRef = await owned(
          c,
          input.proposalMongoId,
          input.actorUserMongoId,
        );
      await run(c, input.runId, proposalRef);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.candidate_review_sets WHERE run_id=$1 AND actor_external_user_id=$2 FOR UPDATE",
        [input.runId, input.actorUserMongoId],
      );
      let reviewId: string, newRevision: number;
      if (!existing.rows[0]) {
        if (input.revision !== 0)
          throw new CandidateApplicationError(
            "REVIEW_REVISION_CONFLICT",
            "Review changed; refresh and try again.",
            409,
          );
        reviewId = uuidv7();
        newRevision = 1;
        await c.query(
          "INSERT INTO rfpilot.candidate_review_sets(id,organization_id,run_id,proposal_reference_id,actor_external_user_id,revision) VALUES($1,$2,$3,$4,$5,1)",
          [reviewId, org, input.runId, proposalRef, input.actorUserMongoId],
        );
      } else {
        if (existing.rows[0].revision !== input.revision)
          throw new CandidateApplicationError(
            "REVIEW_REVISION_CONFLICT",
            "Review changed; refresh and try again.",
            409,
          );
        reviewId = existing.rows[0].id;
        newRevision = input.revision + 1;
        await c.query(
          "UPDATE rfpilot.candidate_review_sets SET revision=$2,updated_at=now() WHERE id=$1",
          [reviewId, newRevision],
        );
      }
      for (const d of input.decisions) {
        const op = await c.query<any>(
          "SELECT id,path,value FROM rfpilot.proposal_context_operations WHERE id=$1 AND run_id=$2",
          [d.operationId, input.runId],
        );
        if (!op.rows[0])
          throw new CandidateApplicationError(
            "INVALID_REVIEW_DECISION",
            "Candidate does not belong to this run.",
          );
        if (isRetiredProposalWorkflowPath(op.rows[0].path))
          throw new CandidateApplicationError(
            "CANDIDATE_PATH_RETIRED",
            "This candidate belongs to a retired proposal section.",
            409,
          );
        if (d.decision === "modified")
          normalizeCandidate(op.rows[0].path, d.value);
        await c.query(
          `INSERT INTO rfpilot.candidate_review_decisions(id,organization_id,review_set_id,operation_id,decision,modified_value,modified_value_checksum,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(review_set_id,operation_id) DO UPDATE SET decision=EXCLUDED.decision,modified_value=EXCLUDED.modified_value,modified_value_checksum=EXCLUDED.modified_value_checksum,reason=EXCLUDED.reason,updated_at=now()`,
          [
            uuidv7(),
            org,
            reviewId,
            d.operationId,
            d.decision,
            d.decision === "modified" ? JSON.stringify(d.value) : null,
            d.decision === "modified" ? checksum(d.value) : null,
            d.reason,
          ],
        );
      }
      return {
        reviewId,
        revision: newRevision,
        savedCount: input.decisions.length,
      };
    });
  },
  readReview(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const proposalRef = await owned(
        c,
        input.proposalMongoId,
        input.actorUserMongoId,
      );
      await run(c, input.runId, proposalRef);
      const review = await c.query<any>(
        "SELECT * FROM rfpilot.candidate_review_sets WHERE run_id=$1 AND actor_external_user_id=$2",
        [input.runId, input.actorUserMongoId],
      );
      const operations = await c.query<any>(
        `SELECT o.id,o.ordinal,o.path,o.value,o.confidence,o.evidence_ids,d.id decision_id,coalesce(d.decision,'pending') decision,d.modified_value,d.reason FROM rfpilot.proposal_context_operations o LEFT JOIN rfpilot.candidate_review_decisions d ON d.operation_id=o.id AND d.review_set_id=$2 WHERE o.run_id=$1 ORDER BY o.ordinal`,
        [input.runId, review.rows[0]?.id ?? null],
      );
      return {
        reviewId: review.rows[0]?.id ?? null,
        revision: review.rows[0]?.revision ?? 0,
        operations: operations.rows.filter(
          (operation: { path: string }) =>
            !isRetiredProposalWorkflowPath(operation.path),
        ),
      };
    });
  },
  createApplication(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    runId: string;
    expectedProposalVersion: number;
    operationIds: string[];
    overwriteConfirmedOperationIds: string[];
    automatic?: boolean;
    idempotencyKey: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        proposalRef = await owned(
          c,
          input.proposalMongoId,
          input.actorUserMongoId,
        );
      await run(c, input.runId, proposalRef);
      const key = `candidate_application:${PROPOSAL_CONTEXT_INPUT_VERSION}:${input.idempotencyKey}`,
        existing = await c.query<any>(
          "SELECT a.*,j.status job_status FROM rfpilot.candidate_applications a JOIN rfpilot.ai_jobs j ON j.id=a.job_id WHERE a.organization_id=$1 AND a.idempotency_key=$2",
          [org, key],
        );
      if (existing.rows[0])
        return { application: existing.rows[0], created: false };
      const review = await c.query<any>(
        "SELECT * FROM rfpilot.candidate_review_sets WHERE run_id=$1 AND actor_external_user_id=$2",
        [input.runId, input.actorUserMongoId],
      );
      if (!review.rows[0])
        throw new CandidateApplicationError(
          "REVIEW_REQUIRED",
          "Save review decisions before applying.",
          409,
        );
      const selected = await c.query<any>(
        `SELECT d.id decision_id,d.decision,d.modified_value,o.id operation_id,o.path,o.value,o.confidence FROM rfpilot.candidate_review_decisions d JOIN rfpilot.proposal_context_operations o ON o.id=d.operation_id WHERE d.review_set_id=$1 AND o.id=ANY($2::uuid[])`,
        [review.rows[0].id, input.operationIds],
      );
      if (
        selected.rows.length !== input.operationIds.length ||
        selected.rows.some(
          (x: any) => !["accepted", "modified"].includes(x.decision),
        )
      )
        throw new CandidateApplicationError(
          "INVALID_APPLICATION_SELECTION",
          "Only accepted or modified candidates may be applied.",
        );
      if (
        selected.rows.some((item: { path: string }) =>
          isRetiredProposalWorkflowPath(item.path),
        )
      )
        throw new CandidateApplicationError(
          "CANDIDATE_PATH_RETIRED",
          "Candidates from retired proposal sections cannot be applied.",
          409,
        );
      if (
        new Set(selected.rows.map((x: any) => x.path)).size !==
        selected.rows.length
      )
        throw new CandidateApplicationError(
          "CONFLICTING_APPLICATION_SELECTION",
          "Select only one candidate for each proposal field.",
          409,
        );
      /* An automatic application must clear the confidence bar the product
         claims. A human who reviewed a low-confidence candidate and accepted it
         deliberately is still allowed through — the threshold governs what the
         system may apply unattended, not what a person may decide. */
      if (input.automatic) {
        const weak = selected.rows.find(
          (x: any) => Number(x.confidence) < AUTO_APPLY_MIN_CONFIDENCE,
        );
        if (weak)
          throw new CandidateApplicationError(
            "AUTO_APPLY_CONFIDENCE_TOO_LOW",
            "Automatic application requires high-confidence candidates; review this one instead.",
            422,
          );
      }
      const appId = uuidv7(),
        jobId = uuidv7();
      await c.query(
        "INSERT INTO rfpilot.ai_jobs(id,organization_id,proposal_reference_id,job_type,status,idempotency_key,input_reference,input_version,max_attempts,correlation_id,initiator_external_user_id) VALUES($1,$2,$3,'candidate_application','queued',$4,$5,'candidate-application.v1',2,$6,$7)",
        [
          jobId,
          org,
          proposalRef,
          key,
          appId,
          input.correlationId,
          input.actorUserMongoId,
        ],
      );
      const app = await c.query<any>(
        "INSERT INTO rfpilot.candidate_applications(id,organization_id,proposal_reference_id,run_id,review_set_id,job_id,actor_external_user_id,status,expected_proposal_version,selected_count,idempotency_key,correlation_id,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11,now()+interval '1 year') RETURNING *",
        [
          appId,
          org,
          proposalRef,
          input.runId,
          review.rows[0].id,
          jobId,
          input.actorUserMongoId,
          input.expectedProposalVersion,
          selected.rows.length,
          key,
          input.correlationId,
        ],
      );
      for (let i = 0; i < selected.rows.length; i++) {
        const x = selected.rows[i],
          normalized = normalizeCandidate(
            x.path,
            x.decision === "modified" ? x.modified_value : x.value,
          );
        await c.query(
          "INSERT INTO rfpilot.candidate_application_items(id,organization_id,application_id,decision_id,operation_id,ordinal,canonical_path,value_checksum,overwrite_confirmed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            uuidv7(),
            org,
            appId,
            x.decision_id,
            x.operation_id,
            i,
            normalized.canonicalPath,
            checksum(normalized.canonicalValue),
            input.overwriteConfirmedOperationIds.includes(x.operation_id),
          ],
        );
      }
      const payload = {
        jobId,
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        jobType: "candidate_application",
        inputReference: appId,
        inputVersion: "candidate-application.v1",
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
        application: { ...app.rows[0], job_id: jobId, job_status: "queued" },
        created: true,
      };
    });
  },
  async execute(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    applicationId: string;
  }) {
    const prepared = await withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const a = await c.query<any>(
        `SELECT a.*,p.external_mongo_id proposal_mongo_id
           FROM rfpilot.candidate_applications a
           JOIN rfpilot.proposal_context_runs cr ON cr.id=a.run_id
           JOIN rfpilot.ai_jobs cj
             ON cj.id=cr.job_id AND cj.input_version=$2
           JOIN rfpilot.proposal_references p ON p.id=a.proposal_reference_id
          WHERE a.id=$1 FOR UPDATE OF a`,
        [input.applicationId, PROPOSAL_CONTEXT_INPUT_VERSION],
      );
      if (!a.rows[0])
        throw new CandidateApplicationError(
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
          404,
        );
      if (a.rows[0].status === "applied")
        return { done: true, application: a.rows[0] };
      await c.query(
        "UPDATE rfpilot.candidate_applications SET status='validating',updated_at=now() WHERE id=$1",
        [input.applicationId],
      );
      const rows = await c.query<any>(
        `SELECT i.operation_id,i.overwrite_confirmed,o.path,o.value,d.decision,d.modified_value FROM rfpilot.candidate_application_items i JOIN rfpilot.proposal_context_operations o ON o.id=i.operation_id JOIN rfpilot.candidate_review_decisions d ON d.id=i.decision_id WHERE i.application_id=$1 ORDER BY i.ordinal`,
        [input.applicationId],
      );
      return { done: false, application: a.rows[0], rows: rows.rows };
    });
    if (prepared.done) return { resultReference: input.applicationId };
    if (
      prepared.rows!.some((item: { path: string }) =>
        isRetiredProposalWorkflowPath(item.path),
      )
    ) {
      await this.markConflict({
        organizationMongoId: input.organizationMongoId,
        applicationId: input.applicationId,
        code: "CANDIDATE_PATH_RETIRED",
      });
      throw new CandidateApplicationError(
        "CANDIDATE_PATH_RETIRED",
        "Candidates from retired proposal sections cannot be applied.",
        409,
      );
    }
    const normalized = prepared.rows!.map((x: any) => ({
        ...normalizeCandidate(
          x.path,
          x.decision === "modified" ? x.modified_value : x.value,
        ),
        operationId: x.operation_id,
        overwriteConfirmed: x.overwrite_confirmed,
      })),
      snapshot = await mongoProposalCandidateMutation.snapshot({
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        proposalMongoId: prepared.application.proposal_mongo_id,
        mongoPaths: normalized.map((x) => x.mongoPath),
        applicationId: input.applicationId,
      });
    if (!snapshot)
      throw new CandidateApplicationError(
        "PROPOSAL_NOT_FOUND",
        "Proposal was not found.",
        404,
      );
    if (snapshot.applicationAlreadyApplied) {
      await this.markApplied({
        organizationMongoId: input.organizationMongoId,
        applicationId: input.applicationId,
        version: snapshot.version,
        beforeChecksum: null,
        afterChecksum: null,
      });
      return { resultReference: input.applicationId };
    }
    if (
      snapshot.version !== prepared.application.expected_proposal_version ||
      snapshot.status !== "unsubmitted" ||
      !snapshot.isDraft ||
      !snapshot.isActive ||
      snapshot.isArchived
    ) {
      await this.markConflict({
        organizationMongoId: input.organizationMongoId,
        applicationId: input.applicationId,
        code: "PROPOSAL_VERSION_OR_LIFECYCLE_CONFLICT",
      });
      throw new CandidateApplicationError(
        "PROPOSAL_VERSION_CONFLICT",
        "Proposal changed or is no longer an active draft.",
        409,
      );
    }
    for (const x of normalized) {
      const current = snapshot.values[x.mongoPath];
      if (requiresOverwriteConfirmation(current, x.mongoValue, x.overwriteConfirmed)) {
        await this.markConflict({
          organizationMongoId: input.organizationMongoId,
          applicationId: input.applicationId,
          code: "OVERWRITE_CONFIRMATION_REQUIRED",
        });
        throw new CandidateApplicationError(
          "OVERWRITE_CONFIRMATION_REQUIRED",
          "Confirm overwrite for existing proposal values.",
          409,
        );
      }
    }
    const updates = Object.fromEntries(
        normalized.map((x) => [x.mongoPath, x.mongoValue]),
      ),
      before = checksum(snapshot.values),
      applied = await mongoProposalCandidateMutation.apply({
        organizationMongoId: input.organizationMongoId,
        actorUserMongoId: input.actorUserMongoId,
        proposalMongoId: prepared.application.proposal_mongo_id,
        applicationId: input.applicationId,
        expectedVersion: snapshot.version,
        updates,
      });
    if (!applied) {
      await this.markConflict({
        organizationMongoId: input.organizationMongoId,
        applicationId: input.applicationId,
        code: "PROPOSAL_VERSION_CONFLICT",
      });
      throw new CandidateApplicationError(
        "PROPOSAL_VERSION_CONFLICT",
        "Proposal changed before application completed.",
        409,
      );
    }
    await this.markApplied({
      organizationMongoId: input.organizationMongoId,
      applicationId: input.applicationId,
      version: applied.version,
      beforeChecksum: before,
      afterChecksum: checksum(updates),
    });
    return { resultReference: input.applicationId };
  },
  markApplied(input: {
    organizationMongoId: string;
    applicationId: string;
    version: number;
    beforeChecksum: string | null;
    afterChecksum: string | null;
  }) {
    return withPostgresTransaction(async (c) => {
      const organizationId = await tenant(c, input.organizationMongoId);
      const application = await c.query<{
        proposal_reference_id: string;
        actor_external_user_id: string;
        expected_proposal_version: number;
        selected_count: number;
        correlation_id: string;
        status: string;
      }>(
        `SELECT a.proposal_reference_id,a.actor_external_user_id,
                a.expected_proposal_version,a.selected_count,a.correlation_id,a.status
           FROM rfpilot.candidate_applications a
           JOIN rfpilot.proposal_context_runs cr ON cr.id=a.run_id
           JOIN rfpilot.ai_jobs cj ON cj.id=cr.job_id AND cj.input_version=$2
          WHERE a.id=$1 FOR UPDATE OF a`,
        [input.applicationId, PROPOSAL_CONTEXT_INPUT_VERSION],
      );
      if (!application.rows[0])
        throw new CandidateApplicationError(
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
          404,
        );
      await c.query(
        "UPDATE rfpilot.candidate_applications SET status='applied',resulting_proposal_version=$2,before_checksum=coalesce($3,before_checksum),after_checksum=coalesce($4,after_checksum),completed_at=now(),updated_at=now() WHERE id=$1",
        [
          input.applicationId,
          input.version,
          input.beforeChecksum,
          input.afterChecksum,
        ],
      );
      if (application.rows[0].status !== "applied")
        await c.query(
          `INSERT INTO rfpilot.audit_events(
             id,organization_id,actor_external_user_id,action,target_type,target_id,
             decision,correlation_id,metadata
           ) VALUES($1,$2,$3,'candidate_fields_applied','candidate_application',$4,'allowed',$5,$6::jsonb)`,
          [
            uuidv7(),
            organizationId,
            application.rows[0].actor_external_user_id,
            input.applicationId,
            application.rows[0].correlation_id,
            JSON.stringify({
              proposalReferenceId: application.rows[0].proposal_reference_id,
              fromProposalVersion:
                application.rows[0].expected_proposal_version,
              resultingProposalVersion: input.version,
              selectedCount: application.rows[0].selected_count,
              beforeChecksumRecorded: input.beforeChecksum !== null,
              afterChecksumRecorded: input.afterChecksum !== null,
            }),
          ],
        );
    });
  },
  markConflict(input: {
    organizationMongoId: string;
    applicationId: string;
    code: string;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      await c.query(
        `UPDATE rfpilot.candidate_applications a
            SET status='conflict',safe_error_code=$2,completed_at=now(),updated_at=now()
          WHERE a.id=$1 AND EXISTS(
            SELECT 1 FROM rfpilot.proposal_context_runs cr
            JOIN rfpilot.ai_jobs cj ON cj.id=cr.job_id AND cj.input_version=$3
            WHERE cr.id=a.run_id
          )`,
        [input.applicationId, input.code, PROPOSAL_CONTEXT_INPUT_VERSION],
      );
    });
  },
  readApplication(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    proposalMongoId: string;
    applicationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const proposalRef = await owned(
        c,
        input.proposalMongoId,
        input.actorUserMongoId,
      );
      const a = await c.query<any>(
        `SELECT a.id,a.status,a.expected_proposal_version,a.resulting_proposal_version,
                a.selected_count,a.safe_error_code,a.job_id,a.created_at,a.completed_at
           FROM rfpilot.candidate_applications a
           JOIN rfpilot.proposal_context_runs cr ON cr.id=a.run_id
           JOIN rfpilot.ai_jobs cj ON cj.id=cr.job_id AND cj.input_version=$3
          WHERE a.id=$1 AND a.proposal_reference_id=$2`,
        [input.applicationId, proposalRef, PROPOSAL_CONTEXT_INPUT_VERSION],
      );
      if (!a.rows[0])
        throw new CandidateApplicationError(
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
          404,
        );
      const items = await c.query<any>(
        "SELECT canonical_path,outcome,safe_error_code FROM rfpilot.candidate_application_items WHERE application_id=$1 ORDER BY ordinal",
        [input.applicationId],
      );
      const visibleItems = items.rows.filter(
        (item: { canonical_path: string }) =>
          !isRetiredCanonicalProposalWorkflowPath(item.canonical_path),
      );
      return {
        ...a.rows[0],
        selected_count: visibleItems.length,
        items: visibleItems,
        recovery: {
          mode: "manual_restore",
          fromProposalVersion: Number(a.rows[0].expected_proposal_version),
          resultingProposalVersion:
            a.rows[0].resulting_proposal_version === null
              ? null
              : Number(a.rows[0].resulting_proposal_version),
          message:
            a.rows[0].status === "applied"
              ? "Restore prior values through the proposal editor or contact an administrator with this application ID."
              : "No field recovery is needed because this application did not complete.",
        },
      };
    });
  },
};
