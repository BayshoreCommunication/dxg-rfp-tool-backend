const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  evaluateSegment,
  isSubstantive,
  segmentText,
  conversationExtractionEnabled,
  MIN_SEGMENT_CHARS,
  MAX_TURNS,
  IDLE_MS,
  RICH_TURN_CHARS,
} = require("../src/modules/conversations/segmentation");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const enabled = (fn) =>
  withEnv({ NODE_ENV: "test", AI_ENVIRONMENT: "test", CONVERSATION_EXTRACTION_ENABLED: "true" }, fn);

const NOW = new Date("2026-07-26T12:00:00.000Z");
const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000);
const turn = (id, content, secondsAgo = 0) => ({ id, content, createdAt: at(secondsAgo) });
const REQUIREMENT =
  "We need 6 breakout rooms at the Chicago Hilton with audio and projection in each.";

test("conversational extraction is deny-by-default", () => {
  withEnv({ NODE_ENV: "test", AI_ENVIRONMENT: "test", CONVERSATION_EXTRACTION_ENABLED: undefined }, () => {
    assert.equal(conversationExtractionEnabled(), false);
    // Even an explicit request extracts nothing while the flag is off.
    assert.deepEqual(
      evaluateSegment({ turns: [turn("m1", REQUIREMENT)], now: NOW, explicit: true }),
      { extract: false, reason: "disabled" },
    );
  });
  // The runtime gate applies on top of the feature flag.
  withEnv({ NODE_ENV: "production", AI_ENVIRONMENT: undefined, CONVERSATION_EXTRACTION_ENABLED: "true" }, () =>
    assert.equal(conversationExtractionEnabled(), false),
  );
});

test("filler never opens a segment, so chatter costs no provider call", () =>
  enabled(() => {
    for (const filler of ["ok", "thanks", "yes please", "can you regenerate that?", "   "]) {
      const decision = evaluateSegment({ turns: [turn("m1", filler)], now: NOW, explicit: true });
      assert.equal(decision.extract, false, filler);
    }
    // Long but contentless prose is still not a requirement.
    assert.equal(isSubstantive("really ".repeat(40)), false);
    assert.equal(
      isSubstantive("Thanks so much, that looks great and I really appreciate all your help here."),
      false,
      "a long thank-you is not a requirement",
    );
    // Substance needs length AND something the schema could hold.
    assert.equal(isSubstantive("6 rooms"), false, "too short even with a number");
    assert.equal(isSubstantive(REQUIREMENT), true, "one clear requirement sentence qualifies");
  }));

test("a segment closes on idle, on turn count, or when the planner asks", () =>
  enabled(() => {
    const fresh = [turn("m1", REQUIREMENT, 1)];
    assert.equal(evaluateSegment({ turns: fresh, now: NOW }).extract, false, "still being typed into");

    const idle = [turn("m1", REQUIREMENT, IDLE_MS / 1000 + 1)];
    assert.equal(evaluateSegment({ turns: idle, now: NOW }).reason, "idle");

    // Explicit intent beats the timer.
    assert.equal(evaluateSegment({ turns: fresh, now: NOW, explicit: true }).reason, "explicit");

    const many = Array.from({ length: MAX_TURNS }, (_, i) => turn(`m${i}`, `${REQUIREMENT} ${i}`, 1));
    assert.equal(evaluateSegment({ turns: many, now: NOW }).reason, "turns");
  }));

test("one detailed brief closes immediately while a short requirement still batches", () =>
  enabled(() => {
    const detailed = `${REQUIREMENT} ${"Include staging, lighting, livestreaming, recording, crew, schedule, and budget details. ".repeat(4)}`;
    assert.ok(detailed.length >= RICH_TURN_CHARS);
    assert.equal(
      evaluateSegment({ turns: [turn("m1", detailed)], now: NOW }).reason,
      "rich_turn",
    );
    assert.equal(
      evaluateSegment({ turns: [turn("m2", REQUIREMENT)], now: NOW }).extract,
      false,
      "short requirements remain open for corrections",
    );
  }));

test("a correction lands in the same segment as what it corrects", () =>
  enabled(() => {
    // This is the whole reason for batching. Extracted per message, "350" would
    // land in a later run, fail to auto-apply because the field is no longer
    // empty, and raise no conflict — the planner states a number twice and the
    // proposal silently keeps the first. One segment puts both values in one
    // run, where the intra-run conflict detector can see them disagree.
    const decision = evaluateSegment({
      turns: [
        turn("m1", "We are expecting 300 in-person attendees at the Chicago Hilton.", 90),
        turn("m2", "Sorry — 350 in-person attendees, not 300.", 60),
      ],
      now: NOW,
    });
    assert.equal(decision.extract, true);
    assert.ok(decision.text.includes("300"), "the original value is in the segment");
    assert.ok(decision.text.includes("350"), "the correction is in the same segment");
  }));

test("segment identity is stable so a replayed message cannot duplicate a source", () =>
  enabled(() => {
    const turns = [turn("m1", REQUIREMENT, 90), turn("m2", "Union venue, 4 cameras.", 60)];
    const first = evaluateSegment({ turns, now: NOW });
    const replay = evaluateSegment({ turns, now: new Date(NOW.getTime() + 5_000) });
    assert.equal(first.idempotencyKey, replay.idempotencyKey);
    assert.equal(first.idempotencyKey, "conversation-segment:m2", "keyed on the closing message");
  }));

test("whitespace-only turns are dropped without breaking the segment", () =>
  enabled(() => {
    const decision = evaluateSegment({
      turns: [turn("m1", "   ", 90), turn("m2", REQUIREMENT, 60), turn("m3", "\n\n", 60)],
      now: NOW,
    });
    assert.equal(decision.extract, true);
    assert.equal(decision.turns.length, 1, "only turns with content are carried");
    assert.equal(segmentText([turn("a", " x "), turn("b", "")]), "x");
    assert.equal(MIN_SEGMENT_CHARS, 40);
  }));

const fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("a chat message evaluates the segment boundary before replying", () => {
  // intent:"chat" previously assigned no run and dispatched nothing, so typed
  // requirements never reached MongoDB by any route.
  const controller = read("controller/conversationsController.ts");
  assert.ok(controller.includes("maybeExtractSegment("), "chat evaluates the boundary");
  assert.ok(
    controller.indexOf("maybeExtractSegment(") > controller.indexOf("appendExchange("),
    "the message is stored before the segment is considered",
  );
});

test("segment intake resolves the tenant before reading any tenant table", () => {
  // The same ordering bug that made purgeProposalArtifacts a permanent no-op:
  // reading a tenant table before the GUC is set means RLS filters everything
  // and the segment silently never closes.
  const intake = read("src/modules/conversations/segmentIntake.ts");
  const guc = intake.indexOf("set_config('app.organization_id'");
  const firstRead = intake.indexOf("FROM rfpilot.proposal_references");
  assert.ok(guc > 0 && firstRead > 0);
  assert.ok(guc < firstRead, "organization GUC precedes the first tenant-table read");
  // Neither intake nor the chain may fail the caller.
  assert.ok(intake.includes("} catch (error) {"), "intake swallows its own failures");
  assert.ok(
    intake.includes("segmentTitle(segmentInput.nextSourceOrdinal)"),
    "conversation source titles use a proposal-wide ordinal, not the current turn count",
  );
  assert.ok(
    intake.includes("count(*)::int n") && intake.includes("origin='conversation'"),
    "every prior conversation source advances the next visible source number",
  );
});

test("extraction chains only for conversation sources that cleared the gates", () => {
  const chain = read("src/modules/conversations/segmentExtraction.ts");
  for (const gate of [
    'source.origin !== "conversation"',
    "conversationExtractionEnabled()",
    "contextEnabled()",
    "LIVE_AI_PROPOSAL_SOURCE_ENABLED",
    'source.status !== "ready"',
    'source.confidentiality !== "non_confidential"',
  ]) {
    assert.ok(chain.includes(gate), `chain checks ${gate}`);
  }
  // Derived from the source id, so a redelivered scan job cannot start a second
  // extraction run for the same segment.
  assert.ok(chain.includes("`conversation-extract:${source.id}`"), "extraction run is idempotent");

  const handler = read("src/modules/durableJobs/sourceSecurityHandler.ts");
  assert.ok(handler.includes("chainConversationExtraction("), "the scan handler chains extraction");
});
