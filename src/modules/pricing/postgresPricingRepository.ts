/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import { PricingError, type ExpertRuleInput, type PricingRecordInput } from "./domain";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };
type ListFilters = { status?: string; category?: string; limit?: number };

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [external]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0]) throw new PricingError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await c.query("SELECT set_config('app.organization_id',$1,true)", [r.rows[0].id]);
  return r.rows[0].id;
};

const audit = (
  c: PoolClient,
  v: { org: string; actor: string; action: string; target: string; id: string; correlation: string; metadata?: object },
) =>
  c.query(
    "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,$4,$5,$6,'allowed',$7,$8::jsonb)",
    [uuidv7(), v.org, v.actor, v.action, v.target, v.id, v.correlation, JSON.stringify(v.metadata || {})],
  );

const listLimit = (limit?: number) => Math.min(Math.max(Number(limit) || 100, 1), 200);

const fragmentExists = async (c: PoolClient, fragmentId: string | null) => {
  if (!fragmentId) return;
  const r = await c.query("SELECT 1 FROM rfpilot.knowledge_source_fragments WHERE id=$1", [fragmentId]);
  if (!r.rowCount) throw new PricingError("SOURCE_FRAGMENT_NOT_FOUND", "The referenced source fragment was not found.", 422);
};

// Rows are re-shaped before leaving the repository: camelCase field names,
// bigint amounts as numbers, and never the tenant discriminator.
const presentRecord = (row: any) => ({
  id: row.id,
  category: row.category,
  itemLabel: row.item_label,
  unit: row.unit,
  amountLowMinor: Number(row.amount_low_minor),
  amountMidMinor: Number(row.amount_mid_minor),
  amountHighMinor: Number(row.amount_high_minor),
  currency: row.currency,
  market: row.market,
  dayType: row.day_type,
  laborRole: row.labor_role,
  sourceFragmentId: row.source_fragment_id,
  sourceNote: row.source_note,
  status: row.status,
  revision: row.revision,
  createdBy: row.created_by_external_user_id,
  approvedBy: row.approved_by_external_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const presentRule = (row: any) => ({
  id: row.id,
  ruleKey: row.rule_key,
  title: row.title,
  explanation: row.explanation,
  conditions: row.conditions,
  effect: row.effect,
  status: row.status,
  revision: row.revision,
  updatedBy: row.updated_by_external_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const lockedRecord = async (c: PoolClient, recordId: string) => {
  const r = await c.query<any>("SELECT * FROM rfpilot.pricing_records WHERE id=$1 FOR UPDATE", [recordId]);
  if (!r.rows[0]) throw new PricingError("PRICING_RECORD_NOT_FOUND", "Pricing record was not found.", 404);
  return r.rows[0];
};
const lockedRule = async (c: PoolClient, ruleId: string) => {
  const r = await c.query<any>("SELECT * FROM rfpilot.expert_rules WHERE id=$1 FOR UPDATE", [ruleId]);
  if (!r.rows[0]) throw new PricingError("EXPERT_RULE_NOT_FOUND", "Expert rule was not found.", 404);
  return r.rows[0];
};

const RECORD_TRANSITIONS: Record<string, readonly string[]> = { draft: ["approved", "retired"], approved: ["retired"], retired: ["draft"] };
const RULE_TRANSITIONS: Record<string, readonly string[]> = { draft: ["active", "retired"], active: ["retired"], retired: [] };

export const pricingRepository = {
  listRecords(ctx: Ctx, filters: ListFilters) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.status) { params.push(filters.status); clauses.push(`status=$${params.length}`); }
      if (filters.category) { params.push(filters.category); clauses.push(`category=$${params.length}`); }
      params.push(listLimit(filters.limit));
      const r = await c.query<any>(
        `SELECT * FROM rfpilot.pricing_records${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY category,item_label LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(presentRecord);
    });
  },

  createRecord(ctx: Ctx, input: PricingRecordInput) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      await fragmentExists(c, input.sourceFragmentId);
      const id = uuidv7();
      const r = await c.query<any>(
        `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,market,day_type,labor_role,source_fragment_id,source_note,status,revision,created_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',1,$15) RETURNING *`,
        [
          id, org, input.category, input.itemLabel, input.unit,
          input.amountLowMinor, input.amountMidMinor, input.amountHighMinor, input.currency,
          input.market, input.dayType, input.laborRole, input.sourceFragmentId, input.sourceNote,
          ctx.actorUserMongoId,
        ],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "pricing_record_created", target: "pricing_record", id, correlation: ctx.correlationId, metadata: { category: input.category, itemLabel: input.itemLabel } });
      return presentRecord(r.rows[0]);
    });
  },

  updateRecord(ctx: Ctx, recordId: string, input: PricingRecordInput, expectedRevision: number) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const existing = await lockedRecord(c, recordId);
      if (existing.status !== "draft")
        throw new PricingError("PRICING_RECORD_NOT_EDITABLE", "Only draft pricing records may be edited.", 409);
      if (existing.revision !== expectedRevision)
        throw new PricingError("REVISION_CONFLICT", "The pricing record changed since it was loaded. Reload and retry.", 409);
      await fragmentExists(c, input.sourceFragmentId);
      const r = await c.query<any>(
        `UPDATE rfpilot.pricing_records SET category=$2,item_label=$3,unit=$4,amount_low_minor=$5,amount_mid_minor=$6,amount_high_minor=$7,currency=$8,market=$9,day_type=$10,labor_role=$11,source_fragment_id=$12,source_note=$13,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          recordId, input.category, input.itemLabel, input.unit,
          input.amountLowMinor, input.amountMidMinor, input.amountHighMinor, input.currency,
          input.market, input.dayType, input.laborRole, input.sourceFragmentId, input.sourceNote,
        ],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "pricing_record_updated", target: "pricing_record", id: recordId, correlation: ctx.correlationId, metadata: { revision: r.rows[0].revision } });
      return presentRecord(r.rows[0]);
    });
  },

  setRecordStatus(ctx: Ctx, recordId: string, status: string) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const existing = await lockedRecord(c, recordId);
      if (!(RECORD_TRANSITIONS[existing.status] || []).includes(status))
        throw new PricingError("INVALID_STATUS_TRANSITION", `A ${existing.status} pricing record cannot move to ${status}.`, 409);
      const r = await c.query<any>(
        "UPDATE rfpilot.pricing_records SET status=$2,approved_by_external_user_id=CASE WHEN $2='approved' THEN $3::varchar WHEN $2='draft' THEN NULL ELSE approved_by_external_user_id END,updated_at=now() WHERE id=$1 RETURNING *",
        [recordId, status, ctx.actorUserMongoId],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "pricing_record_status_changed", target: "pricing_record", id: recordId, correlation: ctx.correlationId, metadata: { from: existing.status, to: status } });
      return presentRecord(r.rows[0]);
    });
  },

  deleteRecord(ctx: Ctx, recordId: string) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const existing = await lockedRecord(c, recordId);
      if (existing.status !== "retired")
        throw new PricingError("PRICING_RECORD_NOT_DELETABLE", "Only retired pricing records may be permanently deleted.", 409);
      await c.query("DELETE FROM rfpilot.pricing_records WHERE id=$1", [recordId]);
      await audit(c, {
        org,
        actor: ctx.actorUserMongoId,
        action: "pricing_record_deleted",
        target: "pricing_record",
        id: recordId,
        correlation: ctx.correlationId,
        metadata: { status: existing.status, category: existing.category, itemLabel: existing.item_label },
      });
      return { id: recordId, deleted: true };
    });
  },

  listRules(ctx: Ctx, filters: ListFilters) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters.status) { params.push(filters.status); clauses.push(`status=$${params.length}`); }
      params.push(listLimit(filters.limit));
      const r = await c.query<any>(
        `SELECT * FROM rfpilot.expert_rules${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY rule_key LIMIT $${params.length}`,
        params,
      );
      return r.rows.map(presentRule);
    });
  },

  createRule(ctx: Ctx, input: ExpertRuleInput) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const duplicate = await c.query("SELECT 1 FROM rfpilot.expert_rules WHERE rule_key=$1", [input.ruleKey]);
      if (duplicate.rowCount)
        throw new PricingError("RULE_KEY_EXISTS", "An expert rule with this key already exists.", 409);
      const id = uuidv7();
      const r = await c.query<any>(
        `INSERT INTO rfpilot.expert_rules(id,organization_id,rule_key,title,explanation,conditions,effect,status,revision,updated_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'draft',1,$8) RETURNING *`,
        [id, org, input.ruleKey, input.title, input.explanation, JSON.stringify(input.conditions), JSON.stringify(input.effect), ctx.actorUserMongoId],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "expert_rule_created", target: "expert_rule", id, correlation: ctx.correlationId, metadata: { ruleKey: input.ruleKey } });
      return presentRule(r.rows[0]);
    });
  },

  updateRule(ctx: Ctx, ruleId: string, input: ExpertRuleInput, expectedRevision: number) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const existing = await lockedRule(c, ruleId);
      if (existing.status !== "draft")
        throw new PricingError("EXPERT_RULE_NOT_EDITABLE", "Only draft expert rules may be edited.", 409);
      if (existing.revision !== expectedRevision)
        throw new PricingError("REVISION_CONFLICT", "The expert rule changed since it was loaded. Reload and retry.", 409);
      if (input.ruleKey !== existing.rule_key)
        throw new PricingError("RULE_KEY_IMMUTABLE", "ruleKey cannot be changed after creation.", 409);
      const r = await c.query<any>(
        `UPDATE rfpilot.expert_rules SET title=$2,explanation=$3,conditions=$4::jsonb,effect=$5::jsonb,revision=revision+1,updated_by_external_user_id=$6,updated_at=now() WHERE id=$1 RETURNING *`,
        [ruleId, input.title, input.explanation, JSON.stringify(input.conditions), JSON.stringify(input.effect), ctx.actorUserMongoId],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "expert_rule_updated", target: "expert_rule", id: ruleId, correlation: ctx.correlationId, metadata: { revision: r.rows[0].revision } });
      return presentRule(r.rows[0]);
    });
  },

  setRuleStatus(ctx: Ctx, ruleId: string, status: string) {
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const existing = await lockedRule(c, ruleId);
      if (!(RULE_TRANSITIONS[existing.status] || []).includes(status))
        throw new PricingError("INVALID_STATUS_TRANSITION", `A ${existing.status} expert rule cannot move to ${status}.`, 409);
      const r = await c.query<any>(
        "UPDATE rfpilot.expert_rules SET status=$2,updated_by_external_user_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
        [ruleId, status, ctx.actorUserMongoId],
      );
      await audit(c, { org, actor: ctx.actorUserMongoId, action: "expert_rule_status_changed", target: "expert_rule", id: ruleId, correlation: ctx.correlationId, metadata: { from: existing.status, to: status } });
      return presentRule(r.rows[0]);
    });
  },
};
