import "../config/env";
import { v7 as uuidv7 } from "uuid";
import { withPostgresTransaction } from "../config/postgres";

// One-off demo seeder: loads approved demo pricing records and active expert
// rules for the first active organization so the investment engine has a
// corpus to work with. Idempotent: records are keyed by item label, rules by
// rule_key. Replace with real DXG historical data before any client demo.

const NOTE = "Demo data - replace with DXG historical contract figures.";
const records: Array<[string, string, string, number, number, number, string | null]> = [
  // [category, itemLabel, unit, low, mid, high (major units), laborRole]
  ["audio", "General session PA & mixing package", "per_day", 3500, 5000, 7500, null],
  ["audio", "Wireless microphone kit (8 channels)", "per_day", 800, 1200, 1800, null],
  ["video", "General session video & IMAG package", "per_day", 6000, 9000, 14000, null],
  ["video", "Confidence monitor pair", "per_day", 600, 900, 1400, null],
  ["lighting", "Stage lighting package", "per_day", 4000, 6500, 10000, null],
  ["staging", "Stage deck & scenic set package", "per_event", 8000, 12000, 18000, null],
  ["labor", "Technical director", "per_day", 950, 1200, 1500, "TD"],
  ["labor", "A1 audio engineer", "per_day", 750, 950, 1200, "A1"],
  ["labor", "V1 video engineer", "per_day", 750, 950, 1200, "V1"],
  ["labor", "L1 lighting operator", "per_day", 700, 900, 1150, "L1"],
  ["labor", "General stagehand", "per_day", 450, 600, 800, "Stagehand"],
  ["breakout_room", "Breakout AV package (projector, screen, audio, 2 mics)", "per_room", 1200, 1800, 2600, null],
  ["general_session", "Twin-screen 16:9 projection package", "per_day", 2500, 3800, 5500, null],
  ["led_wall", "3.9mm LED wall, 10x20 ft", "per_day", 6500, 9500, 14000, null],
  ["projection", "Breakout projector upgrade (laser, 10k lumen)", "per_day", 900, 1400, 2100, null],
  ["trucking_freight", "Local trucking & freight", "per_event", 1500, 2500, 4500, null],
  ["travel_per_diem", "Out-of-town crew travel & per diem", "per_event", 3000, 5000, 9000, null],
  ["insurance", "COI / event liability rider", "per_event", 350, 500, 900, null],
];

const rules: Array<{ key: string; title: string; explanation: string; conditions: object[]; effect: object }> = [
  {
    key: "union_labor_uplift",
    title: "Union venue labor uplift",
    explanation: "Based on DXG experience across union markets.",
    conditions: [{ path: "/content/venueSchedule/isUnionVenue", op: "eq", value: "YES" }],
    effect: { kind: "cost_factor", category: "labor", factorPercent: 20, guidanceText: "Union venues typically add 15-25% to labor through minimum calls, meal penalties and steward requirements." },
  },
  {
    key: "hybrid_virtual_producer",
    title: "Dedicated virtual producer for hybrid events",
    explanation: "Hybrid events fail when the in-room team also runs the stream.",
    conditions: [{ path: "/content/event/eventFormat", op: "eq", value: "Hybrid" }],
    effect: { kind: "recommendation", category: null, guidanceText: "Budget a dedicated virtual producer and a separate stream encoder - hybrid events fail when the in-room team also runs the stream." },
  },
  {
    key: "multi_room_trucking",
    title: "Second truck for four or more rooms",
    explanation: "Larger room counts change freight and load-in crew needs.",
    conditions: [{ path: "/content/venueSchedule/numberOfEventRooms", op: "gte", value: 4 }],
    effect: { kind: "ancillary_flag", category: "trucking_freight", guidanceText: "Four or more rooms usually needs a second truck and extra load-in crew - confirm dock access and freight elevator windows with the venue." },
  },
  {
    key: "recording_deliverable_owner",
    title: "Clarify recording deliverable ownership",
    explanation: "Edited deliverables are a major cost driver vs raw turnover.",
    conditions: [{ path: "/content/videoRecordingStep/videoRecordingRequired", op: "eq", value: "YES" }],
    effect: { kind: "recommendation", category: null, guidanceText: "Confirm who owns post-event editing and turnaround - raw-footage-only turnover is significantly cheaper than edited deliverables." },
  },
];

async function main() {
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
    const by = actor.rows[0].external_mongo_id;
    let createdRecords = 0, createdRules = 0;

    for (const [category, label, unit, low, mid, high, role] of records) {
      const existing = await c.query("SELECT id FROM rfpilot.pricing_records WHERE organization_id=$1 AND item_label=$2", [org.rows[0].id, label]);
      if (existing.rows[0]) continue;
      await c.query(
        `INSERT INTO rfpilot.pricing_records(id,organization_id,category,item_label,unit,amount_low_minor,amount_mid_minor,amount_high_minor,currency,day_type,labor_role,source_note,status,created_by_external_user_id,approved_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'USD','any',$9,$10,'approved',$11,$11)`,
        [uuidv7(), org.rows[0].id, category, label, unit, low * 100, mid * 100, high * 100, role, NOTE, by],
      );
      createdRecords += 1;
    }
    for (const rule of rules) {
      const inserted = await c.query(
        `INSERT INTO rfpilot.expert_rules(id,organization_id,rule_key,title,explanation,conditions,effect,status,updated_by_external_user_id)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active',$8) ON CONFLICT(organization_id,rule_key) DO NOTHING RETURNING id`,
        [uuidv7(), org.rows[0].id, rule.key, rule.title, rule.explanation, JSON.stringify(rule.conditions), JSON.stringify(rule.effect), by],
      );
      if (inserted.rows[0]) createdRules += 1;
    }
    await c.query(
      "INSERT INTO rfpilot.audit_events(id,organization_id,actor_external_user_id,action,target_type,target_id,decision,correlation_id,metadata) VALUES($1,$2,$3,'pricing_demo_seeded','organization',$4,'allowed',$5,$6::jsonb)",
      [uuidv7(), org.rows[0].id, by, org.rows[0].id, uuidv7(), JSON.stringify({ count: createdRecords + createdRules })],
    );
    console.log(`Organization ${org.rows[0].external_mongo_id}: ${createdRecords} pricing record(s), ${createdRules} expert rule(s) seeded (existing entries skipped).`);
  });
  process.exit(0);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
