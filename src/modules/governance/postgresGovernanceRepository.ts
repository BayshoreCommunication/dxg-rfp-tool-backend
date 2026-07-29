/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import {
  GovernanceError,
  type GovernedAssetListFilters,
  type GovernedAssetUpdate,
} from "./domain";

type Context = {
  organizationMongoId: string;
  actorUserMongoId: string;
  correlationId: string;
};

const tenant = async (client: PoolClient, externalId: string) => {
  await client.query(
    "SELECT set_config('app.organization_mongo_id',$1,true)",
    [externalId],
  );
  const result = await client.query<{ id: string }>(
    `SELECT id FROM rfpilot.organizations
     WHERE external_mongo_id=$1 AND status='active'`,
    [externalId],
  );
  if (!result.rows[0]) {
    throw new GovernanceError(
      "ORGANIZATION_NOT_READY",
      "Organization data foundation is unavailable.",
      503,
    );
  }
  await client.query("SELECT set_config('app.organization_id',$1,true)", [
    result.rows[0].id,
  ]);
  return result.rows[0].id;
};

const present = (row: any) => ({
  id: row.id,
  assetType: row.asset_type,
  assetId: row.asset_id,
  ownerExternalUserId: row.owner_external_user_id,
  productArea: row.product_area,
  locale: row.locale,
  sourceReference: row.source_reference,
  effectiveAt: row.effective_at,
  reviewDueAt: row.review_due_at,
  expiresAt: row.expires_at,
  approvalState: row.approval_state,
  lifecycleState: row.lifecycle_state,
  lastVerifiedApplicationRelease:
    row.last_verified_application_release,
  replacementAssetId: row.replacement_asset_id,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const event = async (
  client: PoolClient,
  values: {
    organizationId: string;
    governedAssetId: string;
    eventType: string;
    actor: string;
    fromRevision: number | null;
    toRevision: number;
    correlationId: string;
    metadata?: Record<string, unknown>;
  },
) => {
  await client.query(
    `INSERT INTO rfpilot.governed_asset_events(
      id,organization_id,governed_asset_id,event_type,
      actor_external_user_id,from_revision,to_revision,correlation_id,metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      uuidv7(),
      values.organizationId,
      values.governedAssetId,
      values.eventType,
      values.actor,
      values.fromRevision,
      values.toRevision,
      values.correlationId,
      JSON.stringify(values.metadata || {}),
    ],
  );
  await client.query(
    `INSERT INTO rfpilot.audit_events(
      id,organization_id,actor_external_user_id,action,target_type,target_id,
      decision,correlation_id,metadata
    ) VALUES($1,$2,$3,$4,'governed_asset',$5,'allowed',$6,$7::jsonb)`,
    [
      uuidv7(),
      values.organizationId,
      values.actor,
      `governed_asset.${values.eventType}`,
      values.governedAssetId,
      values.correlationId,
      JSON.stringify(values.metadata || {}),
    ],
  );
};

const locked = async (client: PoolClient, id: string) => {
  const result = await client.query<any>(
    "SELECT * FROM rfpilot.governed_assets WHERE id=$1 FOR UPDATE",
    [id],
  );
  if (!result.rows[0]) {
    throw new GovernanceError(
      "GOVERNED_ASSET_NOT_FOUND",
      "The governed asset was not found.",
      404,
    );
  }
  return result.rows[0];
};

const approvalTransition = (from: string, to: string) =>
  from === to ||
  (from === "draft" && ["approved", "revoked"].includes(to)) ||
  (from === "approved" && to === "revoked");
const lifecycleTransition = (from: string, to: string) =>
  from === to || (from === "active" && to === "retired");

const sourceTable = (assetType: string) => {
  const tables: Record<string, string> = {
    knowledge_release: "knowledge_releases",
    expert_rule: "expert_rules",
    pricing_record: "pricing_records",
    pricing_regional_factor: "pricing_regional_factors",
    pricing_modifier: "pricing_modifiers",
    pricing_confidence_rule: "pricing_confidence_rules",
  };
  const table = tables[assetType];
  if (!table) {
    throw new GovernanceError(
      "UNSUPPORTED_GOVERNED_ASSET",
      "The governed asset type is unsupported.",
      409,
    );
  }
  return table;
};

const synchronizeSourceState = async (
  client: PoolClient,
  row: {
    asset_type: string;
    asset_id: string;
    approval_state: string;
    lifecycle_state: string;
  },
) => {
  const table = sourceTable(row.asset_type);
  if (row.asset_type === "knowledge_release") {
    const state =
      row.approval_state === "revoked"
        ? "revoked"
        : row.lifecycle_state === "retired"
          ? "superseded"
          : "active";
    await client.query(
      `UPDATE rfpilot.${table}
       SET state=$2,revoked_at=CASE WHEN $2='revoked' THEN now() ELSE revoked_at END
       WHERE id=$1`,
      [row.asset_id, state],
    );
    return;
  }
  const status =
    row.approval_state === "draft"
      ? "draft"
      : row.approval_state === "revoked" ||
          row.lifecycle_state === "retired"
        ? "retired"
        : row.asset_type === "expert_rule"
          ? "active"
          : "approved";
  await client.query(
    `UPDATE rfpilot.${table} SET status=$2,updated_at=now() WHERE id=$1`,
    [row.asset_id, status],
  );
};

export const governanceRepository = {
  list(context: Context, filters: GovernedAssetListFilters) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, context.organizationMongoId);
      const clauses: string[] = [];
      const parameters: unknown[] = [];
      const add = (column: string, value: unknown) => {
        if (value === null || value === undefined) return;
        parameters.push(value);
        clauses.push(`${column}=$${parameters.length}`);
      };
      add("asset_type", filters.assetType);
      add("approval_state", filters.approvalState);
      add("lifecycle_state", filters.lifecycleState);
      if (filters.dueWithinDays !== null) {
        parameters.push(filters.dueWithinDays);
        clauses.push(
          `review_due_at <= now()+($${parameters.length}||' days')::interval`,
        );
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const total = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM rfpilot.governed_assets${where}`,
        parameters,
      );
      parameters.push(filters.limit, filters.offset);
      const rows = await client.query<any>(
        `SELECT * FROM rfpilot.governed_assets${where}
         ORDER BY
           CASE WHEN review_due_at<=now() THEN 0 ELSE 1 END,
           review_due_at,asset_type,id
         LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
        parameters,
      );
      return {
        items: rows.rows.map(present),
        total: Number(total.rows[0]?.count || 0),
        limit: filters.limit,
        offset: filters.offset,
      };
    });
  },

  update(
    context: Context,
    governedAssetId: string,
    update: GovernedAssetUpdate,
  ) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(
        client,
        context.organizationMongoId,
      );
      const current = await locked(client, governedAssetId);
      if (current.revision !== update.expectedRevision) {
        throw new GovernanceError(
          "GOVERNANCE_REVISION_CONFLICT",
          "The governed asset changed since it was loaded.",
          409,
        );
      }
      const approval =
        update.approvalState ?? current.approval_state;
      let lifecycle =
        update.lifecycleState ?? current.lifecycle_state;
      if (!approvalTransition(current.approval_state, approval)) {
        throw new GovernanceError(
          "INVALID_GOVERNANCE_TRANSITION",
          `Approval cannot move from ${current.approval_state} to ${approval}.`,
          409,
        );
      }
      if (approval === "revoked") lifecycle = "retired";
      if (!lifecycleTransition(current.lifecycle_state, lifecycle)) {
        throw new GovernanceError(
          "INVALID_GOVERNANCE_TRANSITION",
          `Lifecycle cannot move from ${current.lifecycle_state} to ${lifecycle}.`,
          409,
        );
      }
      const effective = update.effectiveAt ?? current.effective_at;
      const reviewDue = update.reviewDueAt ?? current.review_due_at;
      const expires =
        update.expiresAt !== undefined
          ? update.expiresAt
          : current.expires_at;
      if (new Date(reviewDue).getTime() < new Date(effective).getTime()) {
        throw new GovernanceError(
          "INVALID_GOVERNANCE_DATES",
          "Review due date cannot precede the effective date.",
        );
      }
      if (
        expires &&
        new Date(expires).getTime() <= new Date(effective).getTime()
      ) {
        throw new GovernanceError(
          "INVALID_GOVERNANCE_DATES",
          "Expiry must follow the effective date.",
        );
      }
      const result = await client.query<any>(
        `UPDATE rfpilot.governed_assets SET
          owner_external_user_id=$2,product_area=$3,locale=$4,
          source_reference=$5,effective_at=$6,review_due_at=$7,expires_at=$8,
          approval_state=$9,lifecycle_state=$10,
          last_verified_application_release=$11,
          revision=revision+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          governedAssetId,
          update.ownerExternalUserId ?? current.owner_external_user_id,
          update.productArea ?? current.product_area,
          update.locale ?? current.locale,
          update.sourceReference ?? current.source_reference,
          effective,
          reviewDue,
          expires,
          approval,
          lifecycle,
          update.lastVerifiedApplicationRelease ??
            current.last_verified_application_release,
        ],
      );
      const next = result.rows[0];
      await synchronizeSourceState(client, next);
      const eventType =
        approval === "revoked" && current.approval_state !== "revoked"
          ? "revoked"
          : approval === "approved" &&
              current.approval_state !== "approved"
            ? "approved"
            : lifecycle === "retired" &&
                current.lifecycle_state !== "retired"
              ? "retired"
              : "metadata_updated";
      await event(client, {
        organizationId,
        governedAssetId,
        eventType,
        actor: context.actorUserMongoId,
        fromRevision: current.revision,
        toRevision: next.revision,
        correlationId: context.correlationId,
        metadata: {
          assetType: next.asset_type,
          fields: Object.keys(update).filter(
            (field) => field !== "expectedRevision",
          ),
        },
      });
      return present(next);
    });
  },

  activateReplacement(
    context: Context,
    governedAssetId: string,
    input: {
      replacementGovernedAssetId: string;
      expectedRevision: number;
      replacementExpectedRevision: number;
    },
  ) {
    return withPostgresTransaction(async (client) => {
      const organizationId = await tenant(
        client,
        context.organizationMongoId,
      );
      if (governedAssetId === input.replacementGovernedAssetId) {
        throw new GovernanceError(
          "INVALID_REPLACEMENT",
          "An asset cannot replace itself.",
        );
      }
      const pair = await client.query<any>(
        `SELECT * FROM rfpilot.governed_assets
         WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[governedAssetId, input.replacementGovernedAssetId].sort()],
      );
      const current = pair.rows.find(
        (row) => row.id === governedAssetId,
      );
      const replacement = pair.rows.find(
        (row) => row.id === input.replacementGovernedAssetId,
      );
      if (!current || !replacement) {
        throw new GovernanceError(
          "GOVERNED_ASSET_NOT_FOUND",
          "A governed asset was not found.",
          404,
        );
      }
      if (
        current.revision !== input.expectedRevision ||
        replacement.revision !== input.replacementExpectedRevision
      ) {
        throw new GovernanceError(
          "GOVERNANCE_REVISION_CONFLICT",
          "A governed asset changed since it was loaded.",
          409,
        );
      }
      if (current.asset_type !== replacement.asset_type) {
        throw new GovernanceError(
          "INVALID_REPLACEMENT",
          "Replacement assets must have the same type.",
        );
      }
      const now = Date.now();
      if (
        replacement.approval_state !== "approved" ||
        replacement.lifecycle_state !== "active" ||
        new Date(replacement.effective_at).getTime() > now ||
        (replacement.expires_at &&
          new Date(replacement.expires_at).getTime() <= now)
      ) {
        throw new GovernanceError(
          "REPLACEMENT_NOT_ELIGIBLE",
          "The replacement must be approved, active, effective, and unexpired.",
          409,
        );
      }
      if (current.lifecycle_state !== "active") {
        throw new GovernanceError(
          "GOVERNED_ASSET_ALREADY_RETIRED",
          "Only an active asset can be replaced.",
          409,
        );
      }
      const retired = await client.query<any>(
        `UPDATE rfpilot.governed_assets SET
          lifecycle_state='retired',replacement_asset_id=$2,
          revision=revision+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [current.id, replacement.asset_id],
      );
      await synchronizeSourceState(client, retired.rows[0]);
      await event(client, {
        organizationId,
        governedAssetId,
        eventType: "replacement_activated",
        actor: context.actorUserMongoId,
        fromRevision: current.revision,
        toRevision: retired.rows[0].revision,
        correlationId: context.correlationId,
        metadata: {
          assetType: current.asset_type,
          replacementGovernedAssetId: replacement.id,
        },
      });
      return {
        retired: present(retired.rows[0]),
        activeReplacement: present(replacement),
      };
    });
  },

  events(context: Context, governedAssetId: string) {
    return withPostgresTransaction(async (client) => {
      await tenant(client, context.organizationMongoId);
      await locked(client, governedAssetId);
      const result = await client.query<any>(
        `SELECT event_type,from_revision,to_revision,metadata,created_at
         FROM rfpilot.governed_asset_events
         WHERE governed_asset_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 50`,
        [governedAssetId],
      );
      return result.rows.map((row) => ({
        eventType: row.event_type,
        fromRevision: row.from_revision,
        toRevision: row.to_revision,
        metadata: row.metadata,
        createdAt: row.created_at,
      }));
    });
  },
};
