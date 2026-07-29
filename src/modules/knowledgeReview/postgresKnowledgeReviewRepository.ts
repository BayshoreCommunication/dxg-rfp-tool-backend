/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  independentApprovalRequired,
  KnowledgeReviewError,
  submissionDecision,
  type FragmentDecision,
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
    throw new KnowledgeReviewError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  await c.query("SELECT set_config('app.organization_id',$1,true)", [
    r.rows[0].id,
  ]);
  return r.rows[0].id;
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
const review = async (c: PoolClient, id: string) => {
  const r = await c.query<any>(
    "SELECT * FROM rfpilot.knowledge_review_versions WHERE id=$1",
    [id],
  );
  if (!r.rows[0])
    throw new KnowledgeReviewError(
      "REVIEW_VERSION_NOT_FOUND",
      "Review version was not found.",
      404,
    );
  return r.rows[0];
};
export const knowledgeReviewRepository = {
  start(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    batchId: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      const b = await c.query<{ status: string }>(
        "SELECT status FROM rfpilot.knowledge_import_batches WHERE id=$1 FOR UPDATE",
        [input.batchId],
      );
      if (!b.rows[0])
        throw new KnowledgeReviewError(
          "BATCH_NOT_FOUND",
          "Import batch was not found.",
          404,
        );
      if (
        !["needs_review", "changes_required", "in_review"].includes(
          b.rows[0].status,
        )
      )
        throw new KnowledgeReviewError(
          "INVALID_BATCH_STATE",
          "This batch is not ready for review.",
          409,
        );
      const existing = await c.query<any>(
        "SELECT * FROM rfpilot.knowledge_review_versions WHERE batch_id=$1 AND status='in_review'",
        [input.batchId],
      );
      if (existing.rows[0]) return existing.rows[0];
      const n = await c.query<{ n: number }>(
        "SELECT coalesce(max(version_number),0)+1 n FROM rfpilot.knowledge_review_versions WHERE batch_id=$1",
        [input.batchId],
      );
      const id = uuidv7(),
        r = await c.query<any>(
          "INSERT INTO rfpilot.knowledge_review_versions(id,organization_id,batch_id,version_number,created_by_external_user_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [id, org, input.batchId, n.rows[0].n, input.actorUserMongoId],
        );
      await c.query(
        "UPDATE rfpilot.knowledge_import_batches SET status='in_review',updated_at=now() WHERE id=$1",
        [input.batchId],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.review.start",
        target: "knowledge_review_version",
        id,
        correlation: input.correlationId,
      });
      return r.rows[0];
    });
  },
  detail(input: {
    organizationMongoId: string;
    batchId: string;
    limit: number;
    offset: number;
  }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, input.organizationMongoId);
      const b = await c.query<any>(
        "SELECT * FROM rfpilot.knowledge_import_batches WHERE id=$1",
        [input.batchId],
      );
      if (!b.rows[0])
        throw new KnowledgeReviewError(
          "BATCH_NOT_FOUND",
          "Import batch was not found.",
          404,
        );
      const v = await c.query<any>(
        "SELECT * FROM rfpilot.knowledge_review_versions WHERE batch_id=$1 ORDER BY version_number DESC LIMIT 1",
        [input.batchId],
      );
      const fragments = await c.query<any>(
        `SELECT f.id,f.document_id,f.ordinal,f.content,f.coordinates,f.checksum,coalesce(d.decision,'unreviewed') decision,d.reason
 FROM rfpilot.knowledge_source_fragments f JOIN rfpilot.knowledge_import_documents doc ON doc.id=f.document_id
 LEFT JOIN rfpilot.knowledge_fragment_decisions d ON d.fragment_id=f.id AND d.review_version_id=$2
 WHERE doc.batch_id=$1 ORDER BY doc.created_at,f.ordinal LIMIT $3 OFFSET $4`,
        [input.batchId, v.rows[0]?.id || null, input.limit, input.offset],
      );
      const count = await c.query<{ count: string }>(
        "SELECT count(*) count FROM rfpilot.knowledge_source_fragments f JOIN rfpilot.knowledge_import_documents d ON d.id=f.document_id WHERE d.batch_id=$1",
        [input.batchId],
      );
      return {
        batch: b.rows[0],
        reviewVersion: v.rows[0] || null,
        fragments: fragments.rows,
        total: Number(count.rows[0].count),
      };
    });
  },
  decide(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    reviewVersionId: string;
    fragmentId: string;
    decision: FragmentDecision;
    reason: string | null;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        v = await review(c, input.reviewVersionId);
      if (v.status !== "in_review")
        throw new KnowledgeReviewError(
          "REVIEW_VERSION_IMMUTABLE",
          "Only an in-review version may be changed.",
          409,
        );
      const f = await c.query(
        "SELECT 1 FROM rfpilot.knowledge_source_fragments f JOIN rfpilot.knowledge_import_documents d ON d.id=f.document_id WHERE f.id=$1 AND d.batch_id=$2",
        [input.fragmentId, v.batch_id],
      );
      if (!f.rowCount)
        throw new KnowledgeReviewError(
          "FRAGMENT_NOT_FOUND",
          "Fragment was not found in this review.",
          404,
        );
      const r = await c.query<any>(
        `INSERT INTO rfpilot.knowledge_fragment_decisions(id,organization_id,review_version_id,fragment_id,decision,reason,reviewed_by_external_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(review_version_id,fragment_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,reviewed_by_external_user_id=excluded.reviewed_by_external_user_id,updated_at=now() RETURNING *`,
        [
          uuidv7(),
          org,
          input.reviewVersionId,
          input.fragmentId,
          input.decision,
          input.reason,
          input.actorUserMongoId,
        ],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.fragment.review",
        target: "knowledge_source_fragment",
        id: input.fragmentId,
        correlation: input.correlationId,
        metadata: { decision: input.decision },
      });
      return r.rows[0];
    });
  },
  submit(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    reviewVersionId: string;
    effectiveAt: Date | null;
    expiresAt: Date | null;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        v = await review(c, input.reviewVersionId);
      if (v.status !== "in_review")
        throw new KnowledgeReviewError(
          "REVIEW_VERSION_IMMUTABLE",
          "Only an in-review version may be submitted.",
          409,
        );
      const rows = await c.query<{
        id: string;
        checksum: string;
        decision: string | null;
      }>(
        `SELECT f.id,f.checksum,d.decision FROM rfpilot.knowledge_source_fragments f JOIN rfpilot.knowledge_import_documents doc ON doc.id=f.document_id LEFT JOIN rfpilot.knowledge_fragment_decisions d ON d.fragment_id=f.id AND d.review_version_id=$2 WHERE doc.batch_id=$1 ORDER BY f.id`,
        [v.batch_id, input.reviewVersionId],
      );
      if (!rows.rowCount)
        throw new KnowledgeReviewError(
          "EMPTY_REVIEW",
          "A review must contain source fragments.",
          422,
        );
      const defaultAccepted = rows.rows.filter((x) => !x.decision);
      for (const fragment of defaultAccepted) {
        await c.query(
          `INSERT INTO rfpilot.knowledge_fragment_decisions(id,organization_id,review_version_id,fragment_id,decision,reason,reviewed_by_external_user_id)
           VALUES($1,$2,$3,$4,'accepted',NULL,$5)
           ON CONFLICT(review_version_id,fragment_id) DO NOTHING`,
          [uuidv7(),org,input.reviewVersionId,fragment.id,input.actorUserMongoId],
        );
      }
      const normalizedRows = rows.rows.map((x) => ({
        ...x,
        decision: submissionDecision(x.decision as FragmentDecision | null),
      }));
      if (!normalizedRows.some((x) => x.decision === "accepted"))
        throw new KnowledgeReviewError(
          "NO_ACCEPTED_FRAGMENTS",
          "At least one fragment must remain eligible for the release.",
          422,
        );
      const checksum = crypto
        .createHash("sha256")
        .update(
          normalizedRows
            .map((x) => `${x.id}:${x.checksum.trim()}:${x.decision}`)
            .join("|"),
        )
        .digest("hex");
      const r = await c.query<any>(
        "UPDATE rfpilot.knowledge_review_versions SET status='submitted',submitted_by_external_user_id=$2,submitted_checksum=$3,effective_at=$4,expires_at=$5,submitted_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [
          input.reviewVersionId,
          input.actorUserMongoId,
          checksum,
          input.effectiveAt,
          input.expiresAt,
        ],
      );
      await c.query(
        "UPDATE rfpilot.knowledge_import_batches SET status='submitted',updated_at=now() WHERE id=$1",
        [v.batch_id],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.review.submit",
        target: "knowledge_review_version",
        id: input.reviewVersionId,
        correlation: input.correlationId,
        metadata: {
          defaultAcceptedCount: defaultAccepted.length,
          rejectedCount: normalizedRows.filter((x) => x.decision === "rejected").length,
          flaggedCount: normalizedRows.filter((x) => x.decision === "flagged").length,
        },
      });
      return r.rows[0];
    });
  },
  decideApproval(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    reviewVersionId: string;
    decision: "approved" | "rejected";
    reason: string | null;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId),
        v = await review(c, input.reviewVersionId);
      if (v.status !== "submitted")
        throw new KnowledgeReviewError(
          "REVIEW_NOT_SUBMITTED",
          "Only a submitted version may be decided.",
          409,
        );
      if (
        independentApprovalRequired() &&
        v.submitted_by_external_user_id === input.actorUserMongoId
      )
        throw new KnowledgeReviewError(
          "SELF_APPROVAL_FORBIDDEN",
          "A submitter cannot approve or reject their own version while independent approval is required.",
          403,
        );
      await c.query(
        "INSERT INTO rfpilot.knowledge_approval_decisions(id,organization_id,review_version_id,decision,reason,decided_by_external_user_id,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          uuidv7(),
          org,
          input.reviewVersionId,
          input.decision,
          input.reason,
          input.actorUserMongoId,
          input.correlationId,
        ],
      );
      if (input.decision === "rejected") {
        await c.query(
          "UPDATE rfpilot.knowledge_review_versions SET status='rejected',decided_at=now(),updated_at=now() WHERE id=$1",
          [input.reviewVersionId],
        );
        await c.query(
          "UPDATE rfpilot.knowledge_import_batches SET status='changes_required',updated_at=now() WHERE id=$1",
          [v.batch_id],
        );
        await audit(c, {
          org,
          actor: input.actorUserMongoId,
          action: "knowledge.review.reject",
          target: "knowledge_review_version",
          id: input.reviewVersionId,
          correlation: input.correlationId,
        });
        return {
          reviewVersionId: input.reviewVersionId,
          status: "rejected",
          releaseId: null,
        };
      }
      await c.query(
        "UPDATE rfpilot.knowledge_releases SET state='superseded' WHERE batch_id=$1 AND state='active'",
        [v.batch_id],
      );
      const n = await c.query<{ n: number }>(
          "SELECT coalesce(max(release_number),0)+1 n FROM rfpilot.knowledge_releases WHERE batch_id=$1",
          [v.batch_id],
        ),
        releaseId = uuidv7(),
        effective = v.effective_at || new Date();
      await c.query(
        "INSERT INTO rfpilot.knowledge_releases(id,organization_id,batch_id,review_version_id,release_number,effective_at,expires_at,approved_by_external_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          releaseId,
          org,
          v.batch_id,
          input.reviewVersionId,
          n.rows[0].n,
          effective,
          v.expires_at,
          input.actorUserMongoId,
        ],
      );
      const retiredGovernance = await c.query<any>(
        `UPDATE rfpilot.governed_assets g SET
           lifecycle_state='retired',replacement_asset_id=$3,
           revision=revision+1,updated_at=now()
         FROM rfpilot.knowledge_releases r
         WHERE g.organization_id=$1
           AND g.asset_type='knowledge_release'
           AND g.asset_id=r.id
           AND r.batch_id=$2
           AND r.id<>$3
           AND g.lifecycle_state='active'
         RETURNING g.id,g.revision`,
        [org, v.batch_id, releaseId],
      );
      for (const governed of retiredGovernance.rows) {
        await c.query(
          `INSERT INTO rfpilot.governed_asset_events(
            id,organization_id,governed_asset_id,event_type,
            actor_external_user_id,from_revision,to_revision,correlation_id,
            metadata
          ) VALUES($1,$2,$3,'replacement_activated',$4,$5,$6,$7,$8::jsonb)`,
          [
            uuidv7(),
            org,
            governed.id,
            input.actorUserMongoId,
            governed.revision - 1,
            governed.revision,
            input.correlationId,
            JSON.stringify({ replacementAssetId: releaseId }),
          ],
        );
      }
      await c.query(
        `INSERT INTO rfpilot.knowledge_release_fragments(organization_id,release_id,fragment_id,fragment_checksum)
 SELECT $1,$2,d.fragment_id,f.checksum FROM rfpilot.knowledge_fragment_decisions d JOIN rfpilot.knowledge_source_fragments f ON f.id=d.fragment_id WHERE d.review_version_id=$3 AND d.decision='accepted'`,
        [org, releaseId, input.reviewVersionId],
      );
      await c.query(
        "UPDATE rfpilot.knowledge_review_versions SET status='approved',decided_at=now(),updated_at=now() WHERE id=$1",
        [input.reviewVersionId],
      );
      await c.query(
        "UPDATE rfpilot.knowledge_import_batches SET status='approved',updated_at=now() WHERE id=$1",
        [v.batch_id],
      );
      await c.query(
        "INSERT INTO rfpilot.knowledge_release_events(id,organization_id,release_id,event_type,actor_external_user_id,correlation_id) VALUES($1,$2,$3,'published',$4,$5)",
        [uuidv7(), org, releaseId, input.actorUserMongoId, input.correlationId],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.review.approve",
        target: "knowledge_release",
        id: releaseId,
        correlation: input.correlationId,
      });
      return {
        reviewVersionId: input.reviewVersionId,
        status: "approved",
        releaseId,
      };
    });
  },
  releases(orgExternal: string) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, orgExternal);
      const r = await c.query<any>(
        "SELECT r.*,b.name batch_name,(SELECT count(*) FROM rfpilot.knowledge_release_fragments f WHERE f.release_id=r.id) fragment_count FROM rfpilot.knowledge_releases r JOIN rfpilot.knowledge_import_batches b ON b.id=r.batch_id ORDER BY r.created_at DESC LIMIT 100",
      );
      return r.rows;
    });
  },
  revoke(input: {
    organizationMongoId: string;
    actorUserMongoId: string;
    releaseId: string;
    reason: string;
    correlationId: string;
  }) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, input.organizationMongoId);
      if (input.reason.trim().length < 3 || input.reason.length > 1000)
        throw new KnowledgeReviewError(
          "REVOCATION_REASON_REQUIRED",
          "A revocation reason between 3 and 1,000 characters is required.",
          422,
        );
      const r = await c.query<any>(
        "UPDATE rfpilot.knowledge_releases SET state='revoked',revoked_at=now() WHERE id=$1 AND state='active' RETURNING *",
        [input.releaseId],
      );
      if (!r.rows[0])
        throw new KnowledgeReviewError(
          "ACTIVE_RELEASE_NOT_FOUND",
          "An active release was not found.",
          404,
        );
      const governed = await c.query<any>(
        `UPDATE rfpilot.governed_assets SET
           approval_state='revoked',lifecycle_state='retired',
           revision=revision+1,updated_at=now()
         WHERE organization_id=$1
           AND asset_type='knowledge_release'
           AND asset_id=$2
         RETURNING id,revision`,
        [org, input.releaseId],
      );
      if (governed.rows[0]) {
        await c.query(
          `INSERT INTO rfpilot.governed_asset_events(
            id,organization_id,governed_asset_id,event_type,
            actor_external_user_id,from_revision,to_revision,correlation_id,
            metadata
          ) VALUES($1,$2,$3,'revoked',$4,$5,$6,$7,$8::jsonb)`,
          [
            uuidv7(),
            org,
            governed.rows[0].id,
            input.actorUserMongoId,
            governed.rows[0].revision - 1,
            governed.rows[0].revision,
            input.correlationId,
            JSON.stringify({ reasonRecorded: true }),
          ],
        );
      }
      await c.query(
        "UPDATE rfpilot.knowledge_import_batches SET status='needs_review',updated_at=now() WHERE id=$1",
        [r.rows[0].batch_id],
      );
      await c.query(
        "INSERT INTO rfpilot.knowledge_release_events(id,organization_id,release_id,event_type,actor_external_user_id,reason,correlation_id) VALUES($1,$2,$3,'revoked',$4,$5,$6)",
        [
          uuidv7(),
          org,
          input.releaseId,
          input.actorUserMongoId,
          input.reason.trim(),
          input.correlationId,
        ],
      );
      await audit(c, {
        org,
        actor: input.actorUserMongoId,
        action: "knowledge.release.revoke",
        target: "knowledge_release",
        id: input.releaseId,
        correlation: input.correlationId,
      });
      return r.rows[0];
    });
  },
};
