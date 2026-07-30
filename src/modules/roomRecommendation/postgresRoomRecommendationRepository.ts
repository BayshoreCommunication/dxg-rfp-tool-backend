/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import {
  RoomRecommendationError,
  type ReasonCode,
  type ReviewDecision,
  type RoomRecommendation,
  type RoomRecommendationResult,
} from "./domain";
import { computeRoomRecommendations, generationFingerprint } from "./engine";
import { normalizeRoomWrite } from "./applyAllowlist";
import { syntheticRoomKnowledgeProvider, type RoomKnowledgeProvider } from "./knowledgeProvider";
import { mongoRoomRecommendationMutation, type RoomMutationGuard } from "./mongoRoomRecommendationMutation";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [external]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0]) throw new RoomRecommendationError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await c.query("SELECT set_config('app.organization_id',$1,true)", [r.rows[0].id]);
  return r.rows[0].id;
};
const owned = async (c: PoolClient, proposalId: string, actor: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'",
    [proposalId, actor],
  );
  if (!r.rows[0]) throw new RoomRecommendationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return r.rows[0].id;
};
const runRow = async (c: PoolClient, runId: string, proposalRef: string) => {
  const r = await c.query<any>(
    "SELECT * FROM rfpilot.room_recommendation_runs WHERE id=$1 AND proposal_reference_id=$2",
    [runId, proposalRef],
  );
  if (!r.rows[0]) throw new RoomRecommendationError("RECOMMENDATION_RUN_NOT_FOUND", "Recommendation run was not found.", 404);
  return r.rows[0];
};
const audit = (c: PoolClient, org: string, actor: string, action: string, targetId: string, correlationId: string, metadata: Record<string, unknown>) =>
  c.query(
    "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,'room_recommendation_run',$5,'allowed',$6,$7::jsonb)",
    [uuidv7(), org, actor, action, targetId, correlationId, JSON.stringify(metadata)],
  );
const checksum = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const presentRun = (row: any) => ({
  id: row.id,
  proposalVersion: row.proposal_version,
  schemaVersion: row.schema_version,
  engineVersion: row.engine_version,
  payload: row.payload as RoomRecommendationResult,
  roomCount: row.room_count,
  recommendationCount: row.recommendation_count,
  questionCount: row.question_count,
  warningCount: row.warning_count,
  blockingCount: row.blocking_count,
  createdAt: row.created_at,
});

const recommendationByKey = (payload: RoomRecommendationResult): Map<string, RoomRecommendation & { roomIndex: number; roomLabel: string }> => {
  const map = new Map<string, RoomRecommendation & { roomIndex: number; roomLabel: string }>();
  for (const room of payload.rooms)
    for (const item of room.recommendations)
      map.set(item.recommendationKey, { ...item, roomIndex: room.roomIndex, roomLabel: room.roomLabel });
  return map;
};

export const roomRecommendationRepository = {
  knowledgeProvider: syntheticRoomKnowledgeProvider as RoomKnowledgeProvider,

  // Deterministic generation persisted for review; no model call, no
  // proposal write. Idempotent on the input fingerprint: regenerating an
  // unchanged proposal returns the stored run.
  async generate(ctx: Ctx & { proposalMongoId: string }) {
    const proposal = await Proposal.findOne({ _id: ctx.proposalMongoId, userId: ctx.actorUserMongoId })
      .select("version status isDraft isArchived event venueSchedule hybridVirtual roomByRoom")
      .lean<any>();
    if (!proposal) throw new RoomRecommendationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    const proposalVersion = Number(proposal.version || 1);
    const knowledge = await this.knowledgeProvider.listApproved({ organizationMongoId: ctx.organizationMongoId, asOf: new Date() });
    const fingerprint = generationFingerprint({ proposalVersion, proposal, knowledge });
    const result = computeRoomRecommendations({ proposalId: ctx.proposalMongoId, proposalVersion, proposal, knowledge });
    const recommendationCount = result.rooms.reduce((sum, room) => sum + room.recommendations.length, 0);
    const questionCount = result.rooms.reduce((sum, room) => sum + room.clarificationQuestions.length, 0) + result.globalClarificationQuestions.length;
    const warnings = [...result.rooms.flatMap((room) => room.warnings), ...result.globalWarnings];
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_runs WHERE proposal_reference_id=$1 AND input_checksum=$2",
        [proposalRef, fingerprint],
      );
      if (existing.rows[0]) return { run: presentRun(existing.rows[0]), created: false };
      const row = await c.query<any>(
        `INSERT INTO rfpilot.room_recommendation_runs(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,schema_version,engine_version,input_checksum,payload,room_count,recommendation_count,question_count,warning_count,blocking_count,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          uuidv7(), org, proposalRef, ctx.actorUserMongoId, proposalVersion, result.schemaVersion, result.engineVersion, fingerprint,
          JSON.stringify(result), result.rooms.length, recommendationCount, questionCount,
          warnings.length, warnings.filter((w) => w.severity === "blocking").length, ctx.correlationId,
        ],
      );
      await audit(c, org, ctx.actorUserMongoId, "room_recommendations_generated", row.rows[0].id, ctx.correlationId, {
        proposalVersion, rooms: result.rooms.length, recommendations: recommendationCount, questions: questionCount, warnings: warnings.length,
      });
      return { run: presentRun(row.rows[0]), created: true };
    });
  },

  async latest(ctx: Ctx & { proposalMongoId: string }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const row = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_runs WHERE proposal_reference_id=$1 ORDER BY created_at DESC LIMIT 1",
        [proposalRef],
      );
      if (!row.rows[0]) throw new RoomRecommendationError("RECOMMENDATIONS_NOT_FOUND", "No room recommendations exist for this proposal yet.", 404);
      return presentRun(row.rows[0]);
    });
  },

  async readReview(ctx: Ctx & { proposalMongoId: string; runId: string }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      await runRow(c, ctx.runId, proposalRef);
      const review = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_reviews WHERE run_id=$1 AND actor_external_user_id=$2",
        [ctx.runId, ctx.actorUserMongoId],
      );
      const decisions = review.rows[0]
        ? (await c.query<any>(
            "SELECT recommendation_key,decision,decided_value,reason_code,note FROM rfpilot.room_recommendation_decisions WHERE review_id=$1",
            [review.rows[0].id],
          )).rows
        : [];
      return { reviewId: review.rows[0]?.id ?? null, revision: review.rows[0]?.revision ?? 0, decisions };
    });
  },

  // Field-level review persistence. Decisions snapshot the suggested value,
  // classification and provenance so they double as governed feedback data.
  async saveReview(ctx: Ctx & {
    proposalMongoId: string;
    runId: string;
    revision: number;
    decisions: Array<{ recommendationKey: string; decision: ReviewDecision; value: string | null; reasonCode: ReasonCode | null; note: string | null }>;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const run = await runRow(c, ctx.runId, proposalRef);
      const byKey = recommendationByKey(run.payload as RoomRecommendationResult);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_reviews WHERE run_id=$1 AND actor_external_user_id=$2 FOR UPDATE",
        [ctx.runId, ctx.actorUserMongoId],
      );
      let reviewId: string, newRevision: number;
      if (!existing.rows[0]) {
        if (ctx.revision !== 0) throw new RoomRecommendationError("REVIEW_REVISION_CONFLICT", "Review changed; refresh and try again.", 409);
        reviewId = uuidv7();
        newRevision = 1;
        await c.query(
          "INSERT INTO rfpilot.room_recommendation_reviews(id,organization_id,run_id,proposal_reference_id,actor_external_user_id,revision) VALUES($1,$2,$3,$4,$5,1)",
          [reviewId, org, ctx.runId, proposalRef, ctx.actorUserMongoId],
        );
      } else {
        if (existing.rows[0].revision !== ctx.revision)
          throw new RoomRecommendationError("REVIEW_REVISION_CONFLICT", "Review changed; refresh and try again.", 409);
        reviewId = existing.rows[0].id;
        newRevision = ctx.revision + 1;
        await c.query("UPDATE rfpilot.room_recommendation_reviews SET revision=$2,updated_at=now() WHERE id=$1", [reviewId, newRevision]);
      }
      for (const decision of ctx.decisions) {
        const recommendation = byKey.get(decision.recommendationKey);
        if (!recommendation)
          throw new RoomRecommendationError("INVALID_REVIEW_DECISION", "Recommendation does not belong to this run.");
        // Edited values must clear the same allowlist validation as the
        // original suggestion — a reviewer edit is not a validation bypass.
        if (decision.decision === "edited" && recommendation.applyEligible)
          normalizeRoomWrite(recommendation.path, decision.value);
        await c.query(
          `INSERT INTO rfpilot.room_recommendation_decisions(id,organization_id,review_id,recommendation_key,decision,suggested_value,decided_value,classification,confidence,rule_ids,knowledge_ids,reason_code,note,engine_version)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
           ON CONFLICT(review_id,recommendation_key) DO UPDATE SET decision=EXCLUDED.decision,decided_value=EXCLUDED.decided_value,reason_code=EXCLUDED.reason_code,note=EXCLUDED.note,updated_at=now()`,
          [
            uuidv7(), org, reviewId, decision.recommendationKey, decision.decision,
            JSON.stringify(recommendation.value),
            decision.decision === "edited" ? JSON.stringify(decision.value) : null,
            recommendation.classification, recommendation.confidence,
            JSON.stringify(recommendation.ruleIds), JSON.stringify(recommendation.knowledgeIds),
            decision.reasonCode, decision.note, run.engine_version,
          ],
        );
      }
      await audit(c, org, ctx.actorUserMongoId, "room_recommendations_reviewed", ctx.runId, ctx.correlationId, {
        revision: newRevision, decisions: ctx.decisions.length,
      });
      return { reviewId, revision: newRevision, savedCount: ctx.decisions.length };
    });
  },

  // Explicit application of selected, human-accepted recommendations only.
  // Allowlist-validated writes, proposal-version CAS, per-room identity
  // guards, idempotent on the caller's key. Nothing here runs unattended.
  async apply(ctx: Ctx & {
    proposalMongoId: string;
    runId: string;
    expectedProposalVersion: number;
    recommendationKeys: string[];
    idempotencyKey: string;
  }) {
    const key = `room_recommendation_apply:${ctx.idempotencyKey}`;
    const prepared = await withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const run = await runRow(c, ctx.runId, proposalRef);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_applications WHERE organization_id=$1 AND idempotency_key=$2",
        [org, key],
      );
      if (existing.rows[0]) return { replay: existing.rows[0], org, proposalRef, run, selections: [] as any[], reviewId: "" };
      const review = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_reviews WHERE run_id=$1 AND actor_external_user_id=$2",
        [ctx.runId, ctx.actorUserMongoId],
      );
      if (!review.rows[0]) throw new RoomRecommendationError("REVIEW_REQUIRED", "Save review decisions before applying.", 409);
      const decisions = await c.query<any>(
        "SELECT recommendation_key,decision,decided_value FROM rfpilot.room_recommendation_decisions WHERE review_id=$1 AND recommendation_key=ANY($2::text[])",
        [review.rows[0].id, ctx.recommendationKeys],
      );
      if (decisions.rows.length !== ctx.recommendationKeys.length ||
          decisions.rows.some((row: any) => !["accepted", "edited"].includes(row.decision)))
        throw new RoomRecommendationError("INVALID_APPLICATION_SELECTION", "Only accepted or edited recommendations may be applied.");
      const byKey = recommendationByKey(run.payload as RoomRecommendationResult);
      const selections = decisions.rows.map((row: any) => {
        const recommendation = byKey.get(row.recommendation_key);
        if (!recommendation) throw new RoomRecommendationError("INVALID_APPLICATION_SELECTION", "Recommendation does not belong to this run.");
        if (!recommendation.applyEligible)
          throw new RoomRecommendationError("RECOMMENDATION_NOT_APPLICABLE", "This recommendation is review-only and cannot be applied automatically.", 422);
        const value = row.decision === "edited" ? row.decided_value : recommendation.value;
        return { recommendation, write: normalizeRoomWrite(recommendation.path, value) };
      });
      if (new Set(selections.map((s: any) => s.write.mongoPath)).size !== selections.length)
        throw new RoomRecommendationError("CONFLICTING_APPLICATION_SELECTION", "Select only one recommendation for each room field.", 409);
      return { replay: null, org, proposalRef, run, selections, reviewId: review.rows[0].id };
    });
    if (prepared.replay) return { application: presentApplication(prepared.replay), created: false };

    const guards: RoomMutationGuard[] = [...new Map(
      prepared.selections.map((s: any) => [s.recommendation.roomIndex, { roomIndex: s.recommendation.roomIndex, roomLabel: s.recommendation.roomLabel }]),
    ).values()];
    const sets = Object.fromEntries(prepared.selections.filter((s: any) => s.write.kind === "set").map((s: any) => [s.write.mongoPath, s.write.mongoValue]));
    const appends: Record<string, string[]> = {};
    for (const s of prepared.selections.filter((x: any) => x.write.kind === "append"))
      (appends[s.write.mongoPath] ??= []).push(s.write.mongoValue);
    const updates = { ...sets, ...appends };

    const recordOutcome = (status: "applied" | "conflict", resultingVersion: number | null, safeErrorCode: string | null) =>
      withPostgresTransaction(async (c) => {
        await tenant(c, ctx.organizationMongoId);
        const row = await c.query<any>(
          `INSERT INTO rfpilot.room_recommendation_applications(id,organization_id,run_id,review_id,proposal_reference_id,actor_external_user_id,status,expected_proposal_version,resulting_proposal_version,selected_count,applied_paths,safe_error_code,idempotency_key,correlation_id,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,now()) RETURNING *`,
          [
            uuidv7(), prepared.org, ctx.runId, prepared.reviewId, prepared.proposalRef, ctx.actorUserMongoId,
            status, ctx.expectedProposalVersion, resultingVersion, prepared.selections.length,
            JSON.stringify(prepared.selections.map((s: any) => s.write.path)), safeErrorCode, key, ctx.correlationId,
          ],
        );
        await audit(c, prepared.org, ctx.actorUserMongoId, "room_recommendations_applied", ctx.runId, ctx.correlationId, {
          status, selected: prepared.selections.length, expectedVersion: ctx.expectedProposalVersion,
          resultingVersion, valuesChecksum: checksum(updates),
        });
        return row.rows[0];
      });

    const snapshot = await mongoRoomRecommendationMutation.snapshot(ctx);
    if (!snapshot) throw new RoomRecommendationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    if (snapshot.version !== ctx.expectedProposalVersion || snapshot.status !== "unsubmitted" || !snapshot.isDraft || snapshot.isArchived) {
      await recordOutcome("conflict", null, "PROPOSAL_VERSION_OR_LIFECYCLE_CONFLICT");
      throw new RoomRecommendationError("PROPOSAL_VERSION_CONFLICT", "Proposal changed or is no longer an active draft. Refresh and regenerate before applying.", 409);
    }
    for (const guard of guards) {
      const room = snapshot.roomByRoom[guard.roomIndex];
      const label = room && typeof room.roomFunction === "string" ? room.roomFunction.trim().slice(0, 200) : "";
      if (!room || label !== guard.roomLabel) {
        await recordOutcome("conflict", null, "ROOM_IDENTITY_CONFLICT");
        throw new RoomRecommendationError("ROOM_IDENTITY_CONFLICT", "A selected room was renamed, moved or removed since these recommendations were generated. Regenerate and review again.", 409);
      }
    }
    const applied = await mongoRoomRecommendationMutation.apply({
      organizationMongoId: ctx.organizationMongoId,
      actorUserMongoId: ctx.actorUserMongoId,
      proposalMongoId: ctx.proposalMongoId,
      expectedVersion: ctx.expectedProposalVersion,
      guards,
      sets,
      appends,
    });
    if (!applied) {
      await recordOutcome("conflict", null, "PROPOSAL_VERSION_CONFLICT");
      throw new RoomRecommendationError("PROPOSAL_VERSION_CONFLICT", "Proposal changed before application completed. Refresh and try again.", 409);
    }
    const row = await recordOutcome("applied", applied.version, null);
    return { application: presentApplication(row), created: true };
  },
};

/**
 * Automatic application (product decision 2026-07-27): apply every
 * allowlisted recommendation whose target is still EMPTY, without a prior
 * review. The planner adjusts values in the form afterwards. Filled fields
 * are never overwritten — they are reported back as skipped — and scalar
 * writes plus $addToSet crew appends are the only permitted operations. The
 * proposal-version CAS and per-room identity guards still apply, and the
 * application row records automatic=true with the skipped paths.
 */
const valueAtRelativePath = (room: Record<string, unknown>, relativeMongoPath: string): unknown =>
  relativeMongoPath.split(".").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, room);
const isEmptyTarget = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export const roomRecommendationAutoApply = {
  async apply(ctx: Ctx & { proposalMongoId: string; runId: string; idempotencyKey: string }) {
    const key = `room_recommendation_auto_apply:${ctx.idempotencyKey}`;
    const prepared = await withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const proposalRef = await owned(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const run = await runRow(c, ctx.runId, proposalRef);
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.room_recommendation_applications WHERE organization_id=$1 AND idempotency_key=$2",
        [org, key],
      );
      return { replay: existing.rows[0] ?? null, org, proposalRef, run };
    });
    if (prepared.replay) return { application: presentApplication(prepared.replay), created: false };

    const payload = prepared.run.payload as RoomRecommendationResult;
    const snapshot = await mongoRoomRecommendationMutation.snapshot(ctx);
    if (!snapshot) throw new RoomRecommendationError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    if (snapshot.status !== "unsubmitted" || !snapshot.isDraft || snapshot.isArchived)
      throw new RoomRecommendationError("PROPOSAL_VERSION_CONFLICT", "Proposal is no longer an active draft.", 409);

    const applied: Array<{ write: ReturnType<typeof normalizeRoomWrite>; roomIndex: number; roomLabel: string }> = [];
    const skippedPaths: string[] = [];
    for (const room of payload.rooms) {
      const current = snapshot.roomByRoom[room.roomIndex];
      const label = current && typeof current.roomFunction === "string" ? current.roomFunction.trim().slice(0, 200) : "";
      for (const item of room.recommendations) {
        if (!item.applyEligible) continue;
        // A renamed/moved room invalidates its suggestions rather than the
        // whole application; those are reported as skipped.
        if (!current || label !== room.roomLabel) { skippedPaths.push(item.path); continue; }
        const write = normalizeRoomWrite(item.path, item.value);
        const existingValue = valueAtRelativePath(current, write.relativeMongoPath);
        const alreadyThere = write.kind === "append"
          ? Array.isArray(existingValue) && existingValue.map(String).includes(write.mongoValue)
          : !isEmptyTarget(existingValue);
        if (alreadyThere) { skippedPaths.push(item.path); continue; }
        applied.push({ write, roomIndex: room.roomIndex, roomLabel: room.roomLabel });
      }
    }

    const recordOutcome = (status: "applied" | "conflict", resultingVersion: number | null, safeErrorCode: string | null) =>
      withPostgresTransaction(async (c) => {
        await tenant(c, ctx.organizationMongoId);
        const row = await c.query<any>(
          `INSERT INTO rfpilot.room_recommendation_applications(id,organization_id,run_id,review_id,proposal_reference_id,actor_external_user_id,status,expected_proposal_version,resulting_proposal_version,selected_count,applied_paths,skipped_paths,safe_error_code,automatic,idempotency_key,correlation_id,completed_at)
           VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,true,$13,$14,now()) RETURNING *`,
          [
            uuidv7(), prepared.org, ctx.runId, prepared.proposalRef, ctx.actorUserMongoId,
            status, snapshot.version, resultingVersion, applied.length,
            JSON.stringify(applied.map((s) => s.write.path)), JSON.stringify(skippedPaths),
            safeErrorCode, key, ctx.correlationId,
          ],
        );
        await audit(c, prepared.org, ctx.actorUserMongoId, "room_recommendations_auto_applied", ctx.runId, ctx.correlationId, {
          status, applied: applied.length, skipped: skippedPaths.length, resultingVersion,
        });
        return row.rows[0];
      });

    if (applied.length === 0) {
      const row = await recordOutcome("applied", snapshot.version, null);
      return { application: presentApplication(row), created: true };
    }

    const sets: Record<string, string> = {};
    const appends: Record<string, string[]> = {};
    for (const s of applied) {
      if (s.write.kind === "append") (appends[s.write.mongoPath] ??= []).push(s.write.mongoValue);
      else sets[s.write.mongoPath] = s.write.mongoValue;
    }
    const guards: RoomMutationGuard[] = [...new Map(
      applied.map((s) => [s.roomIndex, { roomIndex: s.roomIndex, roomLabel: s.roomLabel }]),
    ).values()];
    const result = await mongoRoomRecommendationMutation.apply({
      organizationMongoId: ctx.organizationMongoId,
      actorUserMongoId: ctx.actorUserMongoId,
      proposalMongoId: ctx.proposalMongoId,
      expectedVersion: snapshot.version,
      guards,
      sets,
      appends,
    });
    if (!result) {
      await recordOutcome("conflict", null, "PROPOSAL_VERSION_CONFLICT");
      throw new RoomRecommendationError("PROPOSAL_VERSION_CONFLICT", "Proposal changed while filling in recommendations. Regenerate and try again.", 409);
    }
    const row = await recordOutcome("applied", result.version, null);
    return { application: presentApplication(row), created: true };
  },
};

const presentApplication = (row: any) => ({
  id: row.id,
  status: row.status,
  automatic: row.automatic === true,
  expectedProposalVersion: row.expected_proposal_version,
  resultingProposalVersion: row.resulting_proposal_version,
  selectedCount: row.selected_count,
  appliedPaths: row.applied_paths,
  skippedPaths: row.skipped_paths ?? [],
  safeErrorCode: row.safe_error_code,
  createdAt: row.created_at,
});
