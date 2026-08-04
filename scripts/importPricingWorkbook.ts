import "../config/env";
import path from "node:path";
import ExcelJS from "exceljs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../config/postgres";

/*
 * Imports the DXG AV Pricing Engine workbook into the pricing corpus.
 *
 *   npx ts-node scripts/importPricingWorkbook.ts <workbook.xlsx> [--dry-run]
 *
 * The source may be a local path or an s3:// URI. Deployed environments keep
 * PostgreSQL in isolated subnets, so imports there run as a one-off ECS task
 * (api task definition) against a workbook staged in the documents bucket:
 *
 *   node dist/scripts/importPricingWorkbook.js s3://<bucket>/<key>
 *
 * The workbook itself is DXG proprietary data and is deliberately NOT stored in
 * this repository; the operator supplies the path. Re-running is idempotent:
 * records are keyed by (category, subcategory, item label) and updated in place,
 * so a later engine version can be imported with the same command.
 */

const CATEGORY: Record<string, string> = {
  audio: "audio",
  video: "video",
  lighting: "lighting",
  staging: "staging",
  labor: "labor",
  furnishings: "furnishings",
  "streaming/hybrid": "streaming_hybrid",
  "production & management": "production_management",
  connectivity: "connectivity",
  expendables: "expendables",
};

const DIMENSION: Record<string, string> = {
  box: "box", unit: "each", fixture: "fixture", "sq ft": "sq_ft", channel: "channel",
  camera: "camera", ft: "linear_ft", section: "section", run: "run", deck: "deck",
  panel: "panel", element: "element", motor: "motor", snake: "snake", stack: "stack",
  tower: "tower", set: "set", chair: "chair", stool: "stool", room: "room", person: "person",
  plot: "plot", visit: "visit", drop: "drop", roll: "roll", pack: "pack", point: "point", show: "show",
};

const parseUnit = (raw: string): { unit: string; dimension: string | null } => {
  const value = raw.trim().toLowerCase();
  if (value === "multiplier") return { unit: "multiplier", dimension: null };
  if (value === "per day") return { unit: "per_day", dimension: "each" };
  if (value === "per hour") return { unit: "per_hour", dimension: null };
  if (value === "per event") return { unit: "per_event", dimension: null };
  if (value === "per show") return { unit: "per_event", dimension: "show" };
  if (value === "per person/day") return { unit: "per_person", dimension: "person" };
  if (value === "per room/day") return { unit: "per_room", dimension: "room" };
  const perDay = /^per (.+)\/day$/.exec(value);
  if (perDay) return { unit: "per_day", dimension: DIMENSION[perDay[1]] ?? "each" };
  const oneOff = /^per (.+)$/.exec(value);
  if (oneOff) return { unit: "flat", dimension: DIMENSION[oneOff[1]] ?? "each" };
  return { unit: "flat", dimension: null };
};

const money = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const text = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
const key = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

const MODIFIER_SCOPE: Record<string, "labor" | "equipment" | "subtotal"> = {
  union: "labor", in_house: "equipment", multi_day: "equipment", service_charge: "subtotal", venue_fee: "subtotal",
};

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!file) throw new Error("Usage: importPricingWorkbook.ts <workbook.xlsx> [--dry-run]");

  const workbook = new ExcelJS.Workbook();
  if (file.startsWith("s3://")) {
    const [, , bucket, ...rest] = file.split("/");
    const key = rest.join("/");
    if (!bucket || !key) throw new Error(`Malformed S3 URI: ${file}`);
    const region = process.env.DOCUMENT_STORAGE_REGION || process.env.AWS_REGION;
    const body = await new S3Client(region ? { region } : {}).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!body.Body) throw new Error(`Empty object at ${file}`);
    // exceljs bundles its own Buffer typing, which does not structurally
    // match @types/node's; the runtime value is a plain Node Buffer.
    const bytes = Buffer.from(await body.Body.transformToByteArray());
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } else {
    await workbook.xlsx.readFile(path.resolve(file));
  }

  const records: Array<Record<string, unknown>> = [];
  const database = workbook.getWorksheet("Pricing Database");
  if (!database) throw new Error("Sheet 'Pricing Database' not found");
  database.eachRow((row, index) => {
    if (index === 1) return;
    const category = CATEGORY[text(row.getCell(1).value).toLowerCase()];
    const itemLabel = text(row.getCell(3).value);
    const low = money(row.getCell(6).value), mid = money(row.getCell(7).value), high = money(row.getCell(8).value);
    if (!category || !itemLabel || low === null || mid === null || high === null) return;
    if (!(low <= mid && mid <= high)) return;
    const { unit, dimension } = parseUnit(text(row.getCell(5).value));
    records.push({
      category,
      subcategory: text(row.getCell(2).value) || null,
      itemLabel: itemLabel.slice(0, 200),
      spec: text(row.getCell(4).value).slice(0, 300) || null,
      unitLabel: text(row.getCell(5).value).slice(0, 60) || null,
      unit,
      dimension,
      low, mid, high,
      note: text(row.getCell(9).value).slice(0, 500),
      laborRole: category === "labor" ? itemLabel.split(" - ")[0].slice(0, 100) : null,
    });
  });

  const factors: Array<{ market: string; factor: number; notes: string }> = [];
  workbook.getWorksheet("Regional Factors")?.eachRow((row, index) => {
    if (index === 1) return;
    const market = text(row.getCell(1).value);
    const factor = Number(row.getCell(2).value);
    if (!market || !Number.isFinite(factor) || factor <= 0) return;
    factors.push({ market: market.slice(0, 100), factor, notes: text(row.getCell(3).value).slice(0, 300) });
  });

  const modifiers: Array<{ kind: string; conditionKey: string; label: string; factor: number; scope: string; notes: string }> = [];
  let kind: string | null = null;
  workbook.getWorksheet("Modifiers")?.eachRow((row) => {
    const first = text(row.getCell(1).value);
    const factor = Number(row.getCell(2).value);
    const lower = first.toLowerCase();
    if (lower.startsWith("union labor uplift")) { kind = "union"; return; }
    if (lower.startsWith("hotel / venue in-house")) { kind = "in_house"; return; }
    if (lower.startsWith("multi-day")) { kind = "multi_day"; return; }
    if (lower.startsWith("labor time rules")) { kind = null; return; }
    if (!kind || !first || lower === "condition" || !Number.isFinite(factor)) return;
    let effective = kind;
    if (lower.includes("service charge")) effective = "service_charge";
    else if (lower.includes("venue fees")) effective = "venue_fee";
    modifiers.push({
      kind: effective,
      conditionKey: key(first),
      label: first.slice(0, 200),
      factor,
      scope: MODIFIER_SCOPE[effective] ?? "subtotal",
      notes: text(row.getCell(3).value).slice(0, 300),
    });
  });

  const confidence: Array<{ ruleKey: string; label: string; deduction: number; reason: string }> = [];
  workbook.getWorksheet("Confidence Scoring")?.eachRow((row, index) => {
    if (index === 1) return;
    const label = text(row.getCell(1).value);
    const deduction = Math.abs(Number(row.getCell(2).value));
    if (!label || !Number.isFinite(deduction) || deduction <= 0) return;
    confidence.push({ ruleKey: key(label), label: label.slice(0, 200), deduction: Math.round(deduction), reason: text(row.getCell(3).value).slice(0, 300) });
  });

  console.log(`Parsed ${records.length} pricing records, ${factors.length} regional factors, ${modifiers.length} modifiers, ${confidence.length} confidence rules.`);
  if (dryRun) {
    const byCategory = records.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r.category)]: (acc[String(r.category)] ?? 0) + 1 }), {});
    console.log("By category:", byCategory);
    process.exit(0);
  }

  await withPostgresTransaction(async (c) => {
    const org = await c.query<{ id: string; external_mongo_id: string }>(
      "SELECT id,external_mongo_id FROM rfpilot.organizations WHERE status='active' ORDER BY created_at LIMIT 1",
    );
    if (!org.rows[0]) throw new Error("No active organization found");
    await c.query("SELECT set_config('app.organization_id',$1,true)", [org.rows[0].id]);
    await c.query("SELECT set_config('app.organization_mongo_id',$1,true)", [org.rows[0].external_mongo_id]);
    const actor = await c.query<{ external_mongo_id: string }>(
      "SELECT external_mongo_id FROM rfpilot.users WHERE organization_id=$1 AND status='active' ORDER BY created_at LIMIT 1",
      [org.rows[0].id],
    );
    if (!actor.rows[0]) throw new Error("No active user found for the organization");
    const orgId = org.rows[0].id, by = actor.rows[0].external_mongo_id;
    const provenance = "DXG AV Pricing Engine baseline v3 — national estimate, not a calibrated DXG actual.";

    // Earlier hand-seeded demo figures must not compete with the real corpus.
    const retired = await c.query(
      "UPDATE rfpilot.pricing_records SET status='retired',updated_at=now() WHERE organization_id=$1 AND status<>'retired' AND source_note LIKE 'Demo data%'",
      [orgId],
    );

    let inserted = 0, updated = 0;
    for (const r of records) {
      const existing = await c.query<{ id: string }>(
        "SELECT id FROM rfpilot.pricing_records WHERE organization_id=$1 AND category=$2 AND coalesce(subcategory,'')=coalesce($3,'') AND item_label=$4",
        [orgId, r.category, r.subcategory, r.itemLabel],
      );
      const note = (r.note ? `${r.note} — ` : "") + provenance;
      if (existing.rows[0]) {
        await c.query(
          `UPDATE rfpilot.pricing_records SET spec=$2,unit=$3,unit_label=$4,quantity_dimension=$5,
             amount_low_minor=$6,amount_mid_minor=$7,amount_high_minor=$8,labor_role=$9,source_note=$10,
             calibration_tier='baseline',status='approved',approved_by_external_user_id=$11,revision=revision+1,updated_at=now()
           WHERE id=$1`,
          [existing.rows[0].id, r.spec, r.unit, r.unitLabel, r.dimension, r.low, r.mid, r.high, r.laborRole, note.slice(0, 500), by],
        );
        updated += 1;
      } else {
        await c.query(
          `INSERT INTO rfpilot.pricing_records(id,organization_id,category,subcategory,item_label,spec,unit,unit_label,quantity_dimension,
             amount_low_minor,amount_mid_minor,amount_high_minor,currency,day_type,labor_role,source_note,calibration_tier,status,
             created_by_external_user_id,approved_by_external_user_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'USD','any',$13,$14,'baseline','approved',$15,$15)`,
          [uuidv7(), orgId, r.category, r.subcategory, r.itemLabel, r.spec, r.unit, r.unitLabel, r.dimension,
            r.low, r.mid, r.high, r.laborRole, note.slice(0, 500), by],
        );
        inserted += 1;
      }
    }

    for (const f of factors)
      await c.query(
        `INSERT INTO rfpilot.pricing_regional_factors(id,organization_id,market,factor,notes,created_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,market) DO UPDATE SET factor=EXCLUDED.factor,notes=EXCLUDED.notes,updated_at=now()`,
        [uuidv7(), orgId, f.market, f.factor, f.notes, by],
      );
    for (const m of modifiers)
      await c.query(
        `INSERT INTO rfpilot.pricing_modifiers(id,organization_id,kind,condition_key,label,factor,scope,notes,created_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,kind,condition_key) DO UPDATE SET factor=EXCLUDED.factor,label=EXCLUDED.label,scope=EXCLUDED.scope,notes=EXCLUDED.notes,updated_at=now()`,
        [uuidv7(), orgId, m.kind, m.conditionKey, m.label, m.factor, m.scope, m.notes, by],
      );
    for (const r of confidence)
      await c.query(
        `INSERT INTO rfpilot.pricing_confidence_rules(id,organization_id,rule_key,label,deduction,reason,created_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,rule_key) DO UPDATE SET deduction=EXCLUDED.deduction,label=EXCLUDED.label,reason=EXCLUDED.reason,updated_at=now()`,
        [uuidv7(), orgId, r.ruleKey, r.label, r.deduction, r.reason, by],
      );

    await c.query(
      "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'pricing_engine_imported','organization',$4,'allowed',$5,$6::jsonb)",
      [uuidv7(), orgId, by, orgId, uuidv7(), JSON.stringify({ count: inserted + updated })],
    );
    console.log(`Imported: ${inserted} new, ${updated} updated, ${retired.rowCount ?? 0} demo record(s) retired.`);
    console.log(`Regional factors: ${factors.length}. Modifiers: ${modifiers.length}. Confidence rules: ${confidence.length}.`);
  });
  process.exit(0);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
