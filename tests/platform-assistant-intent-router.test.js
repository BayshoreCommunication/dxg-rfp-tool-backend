require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ASSISTANT_INTENT_VERSION,
  classifyAssistantIntent,
  evidenceAllowedForIntent,
  intentUsesOperatingGuidance,
} = require("../src/modules/platformAssistant/intentRouter");

const classification = (query, uiContext = null, history = []) =>
  classifyAssistantIntent({ query, uiContext, history });

test("deterministic router recognizes the initial intent taxonomy", () => {
  const cases = [
    ["Hello!", "greeting_or_thanks"],
    ["Where can I find Settings?", "platform_navigation"],
    ["How do I create a new proposal?", "proposal_creation"],
    ["Review the proposal workflow.", "proposal_review"],
    ["What should I check before sending a proposal?", "pre_send_checklist"],
    ["Plan an event for 500 attendees.", "event_planning"],
    ["What should I enter in this field?", "form_field_help"],
    ["Summarize my current proposal.", "proposal_specific_request"],
    ["Review the equipment scope for missing microphones.", "equipment_scope_review"],
    ["Estimate the budget total.", "budget_estimation"],
    ["Compare this with last year's proposal.", "historical_reference_request"],
    ["Delete my latest proposal.", "action_request"],
    ["What is the weather forecast?", "unsupported_or_off_topic"],
    ["help", "ambiguous"],
  ];

  for (const [query, expected] of cases) {
    const actual = classification(query);
    assert.equal(actual.intent, expected, query);
    assert.equal(actual.version, ASSISTANT_INTENT_VERSION);
  }
});

test("valid field context deterministically constrains a short field question", () => {
  const result = classification("Example?", {
    schemaVersion: "assistant-ui-context.v1",
    routeCategory: "proposal_creation",
    workflow: "proposal_intake",
    sectionId: "event_overview",
    fieldKey: "/content/title",
    fieldKeyStatus: "valid",
  });
  assert.deepEqual(result, {
    intent: "form_field_help",
    version: ASSISTANT_INTENT_VERSION,
    source: "ui_context",
    confidence: "high",
  });
});

test("multi-turn shorthand retains the previous completed assistant intent", () => {
  const result = classification("Now make that shorter.", null, [
    {
      id: "assistant-1",
      role: "assistant",
      status: "complete",
      intent: "event_planning",
    },
  ]);
  assert.equal(result.intent, "event_planning");
  assert.equal(result.source, "follow_up");
  assert.equal(result.confidence, "medium");
});

test("intent filters remove unrelated platform facts and retrieval", () => {
  assert.equal(
    evidenceAllowedForIntent(
      "platform:navigation:create-proposal",
      "proposal_creation",
    ),
    true,
  );
  assert.equal(
    evidenceAllowedForIntent(
      "platform:navigation:settings",
      "proposal_creation",
    ),
    false,
  );
  assert.equal(intentUsesOperatingGuidance("event_planning"), true);
  assert.equal(intentUsesOperatingGuidance("platform_navigation"), false);
});
