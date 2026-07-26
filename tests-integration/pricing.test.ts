// Pricing corpus repository against real Postgres: record lifecycle
// (draft -> revise -> approve -> retire) with revision-conflict handling, and
// expert rule create/activate with key uniqueness.
import { ensureMigrated, ensureServices, randomMongoId, seedTenant, type Tenant } from "./setup";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { closePostgres } from "../config/postgres";
import type { ExpertRuleInput, PricingRecordInput } from "../src/modules/pricing/domain";
import { pricingRepository } from "../src/modules/pricing/postgresPricingRepository";

let tenant: Tenant;
let recordId: string;
let ruleId: string;
let ruleKey: string;

const ctx = () => ({
  organizationMongoId: tenant.organizationMongoId,
  actorUserMongoId: tenant.actorUserMongoId,
  correlationId: crypto.randomUUID(),
});

const recordInput = (overrides: Partial<PricingRecordInput> = {}): PricingRecordInput => ({
  category: "audio",
  itemLabel: "Line array speaker system",
  unit: "per_day",
  amountLowMinor: 50_000,
  amountMidMinor: 75_000,
  amountHighMinor: 100_000,
  currency: "USD",
  market: "Chicago",
  dayType: "standard",
  laborRole: null,
  sourceFragmentId: null,
  sourceNote: "Integration fixture",
  ...overrides,
});

const ruleInput = (overrides: Partial<ExpertRuleInput> = {}): ExpertRuleInput => ({
  ruleKey,
  title: "Hybrid events need a dedicated stream encoder",
  explanation: "Integration fixture rule",
  conditions: [{ path: "/content/event/eventFormat", op: "eq", value: "Hybrid" }],
  effect: { kind: "recommendation", category: "video", guidanceText: "Add a dedicated encoder package.", factorPercent: null },
  ...overrides,
});

before(async () => {
  await ensureServices();
  ensureMigrated();
  tenant = await seedTenant("Pricing Org");
  ruleKey = `integration-rule-${randomMongoId().slice(0, 10)}`;
});

after(async () => {
  await closePostgres();
});

test("createRecord starts as draft revision 1", async () => {
  const created = await pricingRepository.createRecord(ctx(), recordInput());
  recordId = created.id;
  assert.equal(created.status, "draft");
  assert.equal(created.revision, 1);
  assert.equal(created.amountMidMinor, 75_000);
  assert.equal(created.createdBy, tenant.actorUserMongoId);
});

test("updateRecord bumps the revision and rejects stale revisions", async () => {
  const updated = await pricingRepository.updateRecord(
    ctx(),
    recordId,
    recordInput({ itemLabel: "Line array speaker system (revised)", amountHighMinor: 120_000 }),
    1,
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.itemLabel, "Line array speaker system (revised)");

  await assert.rejects(
    pricingRepository.updateRecord(ctx(), recordId, recordInput(), 1),
    (error: unknown) => {
      const typed = error as { code?: string; status?: number };
      return typed.code === "REVISION_CONFLICT" && typed.status === 409;
    },
  );
});

test("record lifecycle: approve, block edits, then retire", async () => {
  const approved = await pricingRepository.setRecordStatus(ctx(), recordId, "approved");
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, tenant.actorUserMongoId);

  await assert.rejects(
    pricingRepository.updateRecord(ctx(), recordId, recordInput(), 2),
    (error: unknown) => (error as { code?: string }).code === "PRICING_RECORD_NOT_EDITABLE",
  );

  // approved -> draft is not a legal transition.
  await assert.rejects(
    pricingRepository.setRecordStatus(ctx(), recordId, "draft"),
    (error: unknown) => (error as { code?: string }).code === "INVALID_STATUS_TRANSITION",
  );

  const retired = await pricingRepository.setRecordStatus(ctx(), recordId, "retired");
  assert.equal(retired.status, "retired");

  // retired is terminal.
  await assert.rejects(
    pricingRepository.setRecordStatus(ctx(), recordId, "approved"),
    (error: unknown) => (error as { code?: string }).code === "INVALID_STATUS_TRANSITION",
  );

  const listed = await pricingRepository.listRecords(ctx(), { status: "retired" });
  assert.ok(listed.some((record: { id: string }) => record.id === recordId));
});

test("expert rules: create draft, enforce key uniqueness, activate", async () => {
  const created = await pricingRepository.createRule(ctx(), ruleInput());
  ruleId = created.id;
  assert.equal(created.status, "draft");
  assert.equal(created.revision, 1);
  assert.equal(created.ruleKey, ruleKey);

  await assert.rejects(
    pricingRepository.createRule(ctx(), ruleInput()),
    (error: unknown) => (error as { code?: string }).code === "RULE_KEY_EXISTS",
  );

  const active = await pricingRepository.setRuleStatus(ctx(), ruleId, "active");
  assert.equal(active.status, "active");

  // Active rules are no longer editable.
  await assert.rejects(
    pricingRepository.updateRule(ctx(), ruleId, ruleInput({ title: "Changed title" }), 1),
    (error: unknown) => (error as { code?: string }).code === "EXPERT_RULE_NOT_EDITABLE",
  );

  const listed = await pricingRepository.listRules(ctx(), { status: "active" });
  assert.ok(listed.some((rule: { id: string }) => rule.id === ruleId));
});
