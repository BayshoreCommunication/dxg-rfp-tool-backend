/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../../../config/postgres";
import Proposal from "../../../modal/proposalsModel";
import {
  computeInvestmentGuidance, InvestmentError,
  type ConfidenceRule, type ExpertRule, type PricingModifier, type PricingRecord, type RegionalFactor,
} from "./domain";

type Ctx = { organizationMongoId: string; actorUserMongoId: string; correlationId: string };

const ENGINE_VERSION = "dxg-av-pricing-engine.v2";

const tenant = async (c: PoolClient, external: string) => {
  await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [external]);
  const r = await c.query<{ id: string }>(
    "SELECT id FROM rfpilot.organizations WHERE external_mongo_id=$1 AND status='active'",
    [external],
  );
  if (!r.rows[0]) throw new InvestmentError("ORGANIZATION_NOT_READY", "Organization data foundation is unavailable.", 503);
  await c.query("SELECT set_config('app.organization_id',$1,true)", [r.rows[0].id]);
  return r.rows[0].id;
};
const proposalRef = async (c: PoolClient, id: string, actor: string) => {
  const r = await c.query<{ id: string }>(
    "SELECT p.id FROM rfpilot.proposal_references p JOIN rfpilot.users u ON u.id=p.owner_user_id WHERE p.external_mongo_id=$1 AND u.external_mongo_id=$2 AND u.status='active'",
    [id, actor],
  );
  if (!r.rows[0]) throw new InvestmentError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
  return r.rows[0].id;
};

// investment_guidance_reports predates the pricing engine and has no column for
// confidence / assumptions / scenarios / basis. Rather than lose them on read,
// the line_items payload carries an envelope; legacy array payloads still read
// back cleanly. A migration promoting these to real columns is the follow-up.
const envelope = (result: ReturnType<typeof computeInvestmentGuidance>) => ({
  payloadVersion: 2,
  lineItems: result.lineItems,
  confidence: result.confidence,
  assumptions: result.assumptions,
  scenarios: result.scenarios,
  basis: result.basis,
});
const unwrap = (stored: unknown) => {
  if (Array.isArray(stored)) return { lineItems: stored, confidence: null, assumptions: [], scenarios: [], basis: null };
  const payload = (stored ?? {}) as Record<string, unknown>;
  return {
    lineItems: Array.isArray(payload.lineItems) ? payload.lineItems : [],
    confidence: payload.confidence ?? null,
    assumptions: Array.isArray(payload.assumptions) ? payload.assumptions : [],
    scenarios: Array.isArray(payload.scenarios) ? payload.scenarios : [],
    basis: payload.basis ?? null,
  };
};

const present = (row: any) => {
  const payload = unwrap(row.line_items);
  return {
    id: row.id,
    proposalVersion: row.proposal_version,
    engineVersion: row.engine_version,
    currency: row.currency ? String(row.currency).trim() : null,
    totalLowMinor: row.total_low_minor === null ? null : Number(row.total_low_minor),
    totalMidMinor: row.total_mid_minor === null ? null : Number(row.total_mid_minor),
    totalHighMinor: row.total_high_minor === null ? null : Number(row.total_high_minor),
    lineItems: payload.lineItems,
    refusals: row.refusals,
    ancillary: row.ancillary,
    recommendations: row.recommendations,
    confidence: payload.confidence,
    assumptions: payload.assumptions,
    scenarios: payload.scenarios,
    basis: payload.basis,
    createdAt: row.created_at,
  };
};

export const investmentRepository = {
  async generate(ctx: Ctx & { proposalMongoId: string }) {
    const proposal = await Proposal.findOne({ _id: ctx.proposalMongoId, userId: ctx.actorUserMongoId }).lean<any>();
    if (!proposal) throw new InvestmentError("PROPOSAL_NOT_FOUND", "Proposal was not found.", 404);
    return withPostgresTransaction(async (c) => {
      const org = await tenant(c, ctx.organizationMongoId);
      const p = await proposalRef(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const records = await c.query<any>(
        "SELECT id,category,subcategory,spec,item_label,unit,unit_label,quantity_dimension,calibration_tier,amount_low_minor,amount_mid_minor,amount_high_minor,currency,market,day_type,labor_role FROM rfpilot.pricing_records WHERE organization_id=$1 AND status='approved'",
        [org],
      );
      const rules = await c.query<any>(
        "SELECT id,rule_key,title,explanation,conditions,effect FROM rfpilot.expert_rules WHERE organization_id=$1 AND status='active'",
        [org],
      );
      const regional = await c.query<any>(
        "SELECT id,market,factor,notes FROM rfpilot.pricing_regional_factors WHERE organization_id=$1 AND status='approved'",
        [org],
      );
      const modifierRows = await c.query<any>(
        "SELECT id,kind,condition_key,label,factor,scope,notes FROM rfpilot.pricing_modifiers WHERE organization_id=$1 AND status='approved'",
        [org],
      );
      const confidenceRows = await c.query<any>(
        "SELECT id,rule_key,label,deduction,reason FROM rfpilot.pricing_confidence_rules WHERE organization_id=$1 AND status='approved'",
        [org],
      );
      const pricing: PricingRecord[] = records.rows.map((row: any) => ({
        id: row.id, category: row.category, itemLabel: row.item_label, unit: row.unit,
        amountLowMinor: Number(row.amount_low_minor), amountMidMinor: Number(row.amount_mid_minor), amountHighMinor: Number(row.amount_high_minor),
        currency: String(row.currency).trim(), market: row.market, dayType: row.day_type, laborRole: row.labor_role,
        subcategory: row.subcategory, spec: row.spec, unitLabel: row.unit_label,
        quantityDimension: row.quantity_dimension, calibrationTier: row.calibration_tier,
      }));
      const expertRules: ExpertRule[] = rules.rows.map((row: any) => ({
        id: row.id, ruleKey: row.rule_key, title: row.title, explanation: row.explanation,
        conditions: row.conditions ?? [], effect: row.effect ?? {},
      }));
      const regionalFactors: RegionalFactor[] = regional.rows.map((row: any) => ({
        id: row.id, market: String(row.market).trim(), factor: Number(row.factor), notes: row.notes ?? "",
      }));
      const modifiers: PricingModifier[] = modifierRows.rows.map((row: any) => ({
        id: row.id, kind: row.kind, conditionKey: row.condition_key, label: row.label,
        factor: Number(row.factor), scope: row.scope, notes: row.notes ?? "",
      }));
      const confidenceRules: ConfidenceRule[] = confidenceRows.rows.map((row: any) => ({
        id: row.id, ruleKey: row.rule_key, label: row.label, deduction: Number(row.deduction), reason: row.reason ?? "",
      }));
      const result = computeInvestmentGuidance(proposal, pricing, expertRules, regionalFactors, modifiers, confidenceRules);
      const row = await c.query<any>(
        `INSERT INTO rfpilot.investment_guidance_reports(id,organization_id,proposal_reference_id,actor_external_user_id,proposal_version,engine_version,currency,total_low_minor,total_mid_minor,total_high_minor,line_items,refusals,ancillary,recommendations,correlation_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15) RETURNING *`,
        [
          uuidv7(), org, p, ctx.actorUserMongoId, Number(proposal.version || 1), ENGINE_VERSION,
          result.currency, result.totalLowMinor, result.totalMidMinor, result.totalHighMinor,
          JSON.stringify(envelope(result)), JSON.stringify(result.refusals), JSON.stringify(result.ancillary), JSON.stringify(result.recommendations),
          ctx.correlationId,
        ],
      );
      await c.query(
        "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'investment_guidance_generated','proposal',$4,'allowed',$5,$6::jsonb)",
        [uuidv7(), org, ctx.actorUserMongoId, p, ctx.correlationId, JSON.stringify({
          count: result.lineItems.length,
          outcome: result.refusals.length ? "partial" : "priced",
          confidenceBand: result.confidence.band,
          market: result.basis.market,
        })],
      );
      return present(row.rows[0]);
    });
  },
  async latest(ctx: Ctx & { proposalMongoId: string }) {
    return withPostgresTransaction(async (c) => {
      await tenant(c, ctx.organizationMongoId);
      const p = await proposalRef(c, ctx.proposalMongoId, ctx.actorUserMongoId);
      const row = await c.query<any>(
        "SELECT * FROM rfpilot.investment_guidance_reports WHERE proposal_reference_id=$1 ORDER BY created_at DESC LIMIT 1",
        [p],
      );
      if (!row.rows[0]) throw new InvestmentError("INVESTMENT_GUIDANCE_NOT_FOUND", "No investment guidance exists for this proposal yet.", 404);
      return present(row.rows[0]);
    });
  },
};
