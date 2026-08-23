require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ASSISTANT_EVIDENCE_MAX_CHARACTERS,
  ASSISTANT_HISTORY_MAX_CHARACTERS,
  PlatformAssistantError,
} = require("../src/modules/platformAssistant/domain");
const {
  PLATFORM_FACTS,
  PLATFORM_KNOWLEDGE_VERSION,
  platformFactsForConversation,
  platformFactsForUiContext,
  platformFactsForQuery,
} = require("../src/modules/platformAssistant/platformKnowledge");
const {
  PLATFORM_ASSISTANT_INSTRUCTIONS,
  buildAssistantPromptInput,
  normalizeConversationalAssistantResponse,
  validateAssistantProviderResponse,
} = require("../src/modules/platformAssistant/prompt");
const {
  createApprovedKnowledgeSource,
} = require("../src/modules/platformAssistant/approvedKnowledgeSource");
const {
  DeterministicAssistantProvider,
} = require("../src/modules/platformAssistant/deterministicAssistantProvider");
const {
  createPlatformAssistantApplication,
} = require("../src/modules/platformAssistant/application");
const {
  proposalFormGuidanceEvidenceForQuery,
} = require("../src/modules/platformAssistant/proposalFormGuidance");

const root = path.resolve(__dirname, "..");
const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/platform-assistant-guidance.json"),
    "utf8",
  ),
);

const context = {
  organizationMongoId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  actorUserMongoId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  correlationId: "correlation",
};
const threadId = "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e6f";

const message = (overrides = {}) => ({
  id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e70",
  threadId,
  ordinal: 1,
  role: "user",
  content: "Explain the proposal workflow.",
  status: "complete",
  providerResponseId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  safeErrorCode: null,
  citations: [],
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
  completedAt: "2026-07-26T00:00:00.000Z",
  ...overrides,
});

const thread = {
  id: threadId,
  title: "Platform help",
  status: "active",
  messageCount: 2,
  lastMessageAt: "2026-07-26T00:00:00.000Z",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const withEnabledAssistant = async (work) => {
  const keys = [
    "NODE_ENV",
    "AI_ENVIRONMENT",
    "AI_ASSISTANT_ENABLED",
    "AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS",
    "AI_ASSISTANT_KILL_SWITCH",
    "LIVE_AI_KILL_SWITCH",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "production",
    AI_ENVIRONMENT: "staging",
    AI_ASSISTANT_ENABLED: "true",
    AI_ASSISTANT_ALLOWED_ORGANIZATION_IDS: "*",
    AI_ASSISTANT_KILL_SWITCH: "false",
    LIVE_AI_KILL_SWITCH: "false",
  });
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("platform map is versioned, bounded, and contains internal routes only", () => {
  assert.equal(PLATFORM_KNOWLEDGE_VERSION, "rfpilot-platform-map.v7");
  assert.ok(PLATFORM_FACTS.length >= 8);
  assert.equal(new Set(PLATFORM_FACTS.map((fact) => fact.id)).size, PLATFORM_FACTS.length);
  for (const fact of PLATFORM_FACTS) {
    assert.match(fact.id, /^platform:/);
    assert.ok(fact.content.length > 20 && fact.content.length <= 1000);
    if (fact.href) assert.match(fact.href, /^\//);
  }
  const selected = platformFactsForQuery("Where are vendor responses?", 3);
  assert.ok(selected.length <= 3);
  assert.ok(selected.some((fact) => fact.id === "platform:navigation:vendor-responses"));
  assert.ok(selected.every((fact) => fact.trust === "trusted_platform_fact"));
  assert.ok(
    platformFactsForQuery(
      "What information should I gather before planning an event?",
    ).some((fact) => fact.id === "platform:event:planning-brief"),
  );
  assert.ok(
    platformFactsForQuery(
      "১৫০০ জনের ইভেন্টের জন্য কী কী তথ্য আগে সংগ্রহ করব?",
    ).some((fact) => fact.id === "platform:event:planning-brief"),
  );
  const guided = platformFactsForQuery(
    "Explain the proposal creation steps and input fields.",
  );
  assert.ok(
    guided.some((fact) => fact.id === "platform:proposal:guided-intake"),
  );
  assert.ok(
    guided.some((fact) => fact.id === "platform:proposal:event-fields"),
  );
  assert.ok(
    guided.some((fact) => fact.id === "platform:proposal:venue-room-fields"),
  );
});

test("common settings typos still select the approved Settings route", () => {
  const selected = platformFactsForQuery("wher is seting page?", 3);

  assert.ok(
    selected.some((item) => item.id === "platform:navigation:settings"),
  );
  assert.equal(
    selected.find((item) => item.id === "platform:navigation:settings")?.href,
    "/settings",
  );
});

test("current rendered form metadata becomes bounded field evidence", () => {
  const evidence = platformFactsForUiContext({
    schemaVersion: "assistant-ui-context.v1",
    routeCategory: "proposal_creation",
    workflow: "proposal_intake",
    fieldKeyStatus: "not_provided",
    fieldControl: {
      label: "Streaming Platform",
      helperText: "Choose the platform delivering the virtual experience.",
      requirement: "conditional",
      controlType: "select",
      options: ["Zoom", "Teams", "Vendor Recommendation Needed"],
      maximumSelections: 1,
      placeholder: "Select platform...",
    },
  });
  const field = evidence.find(
    (item) => item.id === "form-field:current-rendered-control",
  );
  assert.ok(field);
  assert.equal(field.sourceType, "operating_guidance");
  assert.equal(field.trust, "untrusted_retrieved_content");
  assert.match(field.content, /current form marks this field conditional/i);
  assert.match(field.content, /Zoom; Teams; Vendor Recommendation Needed/);
  assert.match(field.content, /maximum 1/);
  assert.doesNotMatch(field.content, /private|current value/i);
});

test("an explicitly named current field outranks stale field history", () => {
  const current = message({
    id: "current-investment-field",
    ordinal: 7,
    content: 'Explain every available option for "Investment Flexibility".',
  });
  const selected = platformFactsForConversation(
    current.content,
    [
      message({
        id: "older-event-name",
        ordinal: 1,
        content: 'What should I enter for the "Event Name" field?',
      }),
      message({
        id: "older-event-format",
        ordinal: 3,
        content: 'Show every option for the "Event Format" field.',
      }),
      message({
        id: "older-tone",
        ordinal: 5,
        content: 'Show every option for "Tone / Brand Direction".',
      }),
      current,
    ],
    current.id,
  );

  assert.equal(selected[0].title, "Investment & Evaluation: Investment Flexibility");
  assert.match(selected[0].content, /Fixed, Flexible, Value-Engineering Welcome, Not Sure/);
  assert.ok(
    !selected.some((item) =>
      item.title.includes("Tone / Brand Direction"),
    ),
  );
});

test("deterministic field help uses current rendered choices without guessing", async () => {
  const provider = new DeterministicAssistantProvider();
  const uiContext = {
    schemaVersion: "assistant-ui-context.v1",
    routeCategory: "proposal_creation",
    workflow: "proposal_intake",
    fieldKeyStatus: "not_provided",
    fieldControl: {
      label: "Streaming Platform",
      helperText: "Choose the platform delivering the virtual experience.",
      controlType: "select",
      options: ["Zoom", "Teams", "Vendor Recommendation Needed"],
      maximumSelections: 1,
    },
  };
  const prompt = buildAssistantPromptInput({
    userMessage: message({
      id: "rendered-field-user",
      content: 'What should I enter for the "Streaming Platform" field?',
    }),
    history: [],
    platformFacts: platformFactsForUiContext(uiContext),
    operatingGuidance: [],
    uiContext,
  });
  const response = validateAssistantProviderResponse(
    await provider.generate(prompt),
    prompt.evidence,
  );
  assert.equal(response.kind, "answer");
  assert.match(response.content, /Streaming Platform/);
  assert.match(response.content, /Zoom; Teams; Vendor Recommendation Needed/);
  assert.deepEqual(response.citationIds, [
    "form-field:current-rendered-control",
  ]);
});

test("platform fact selection carries prior user topics into follow-up and summary turns", () => {
  const current = message({
    id: "current-summary",
    ordinal: 5,
    content: "Summarize everything we discussed and include the relevant links.",
  });
  const selected = platformFactsForConversation(
    current.content,
    [
      message({
        id: "history-vendors",
        ordinal: 1,
        content: "Where can I see vendor responses?",
      }),
      message({
        id: "history-event",
        ordinal: 3,
        content: "What should I collect for a 1,500-person hybrid event?",
      }),
      current,
    ],
    current.id,
  );

  assert.ok(
    selected.some(
      (fact) => fact.id === "platform:navigation:vendor-responses",
    ),
  );
  assert.ok(
    selected.some((fact) => fact.id === "platform:event:planning-brief"),
  );

  const followUp = message({
    id: "current-follow-up",
    ordinal: 7,
    content: "Make that concise with bullets and include the relevant page link.",
  });
  const followUpSelected = platformFactsForConversation(
    followUp.content,
    [
      message({
        id: "older-vendors",
        ordinal: 1,
        content: "Where can I see vendor responses?",
      }),
      message({
        id: "latest-event",
        ordinal: 5,
        content:
          "The event is next week but venue and budget are not confirmed. What comes first?",
      }),
      followUp,
    ],
    followUp.id,
  );
  assert.ok(
    followUpSelected.some(
      (fact) => fact.id === "platform:event:planning-brief",
    ),
  );
  assert.ok(
    !followUpSelected.some(
      (fact) => fact.id === "platform:navigation:vendor-responses",
    ),
  );

  const mentionedLinks = message({
    id: "current-links",
    ordinal: 11,
    content: "Give me only the RFPilot page links we mentioned.",
  });
  const mentionedLinkFacts = platformFactsForConversation(
    mentionedLinks.content,
    [
      message({
        id: "history-dashboard",
        ordinal: 1,
        content: "Where is the Dashboard?",
      }),
      message({
        id: "history-vendor-link",
        ordinal: 3,
        content: "Where can I see vendor responses?",
      }),
      message({
        id: "history-settings-link",
        ordinal: 5,
        content: "Where do I manage branding settings?",
      }),
      message({
        id: "history-email-link",
        ordinal: 7,
        content: "Where can I see proposal email activity?",
      }),
      mentionedLinks,
    ],
    mentionedLinks.id,
  );
  assert.deepEqual(
    [
      "platform:navigation:dashboard",
      "platform:navigation:vendor-responses",
      "platform:navigation:settings",
      "platform:navigation:email",
    ].filter((id) => mentionedLinkFacts.some((fact) => fact.id === id)),
    [
      "platform:navigation:dashboard",
      "platform:navigation:vendor-responses",
      "platform:navigation:settings",
      "platform:navigation:email",
    ],
  );

  const recordDetails = message({
    id: "current-record-details",
    ordinal: 15,
    content: "Which RFPilot page should I use to record these details?",
  });
  const recordDetailFacts = platformFactsForConversation(
    recordDetails.content,
    [
      message({
        id: "history-event-plan",
        ordinal: 7,
        content:
          "I am planning a three-day hybrid event for 1,500 attendees.",
      }),
      message({
        id: "history-room-plan",
        ordinal: 9,
        content: "We will have six breakout rooms.",
      }),
      message({
        id: "history-summary-plan",
        ordinal: 11,
        content: "Summarize the five most important items.",
      }),
      message({
        id: "history-format-plan",
        ordinal: 13,
        content: "Make that shorter and use bullets.",
      }),
      recordDetails,
    ],
    recordDetails.id,
  );
  assert.ok(
    recordDetailFacts.some(
      (fact) => fact.id === "platform:navigation:create-proposal",
    ),
  );
  assert.ok(
    recordDetailFacts.some(
      (fact) => fact.id === "platform:proposal:guided-intake",
    ),
  );
});

test("prompt builder bounds history and labels retrieved guidance as untrusted", () => {
  const user = message({ content: "What should I gather for an event?" });
  const history = Array.from({ length: 40 }, (_, index) =>
    message({
      id: `history-${index}`,
      ordinal: index + 1,
      role: index % 2 ? "assistant" : "user",
      content: `history-${index} ${"x".repeat(990)}`,
    }),
  );
  const guidance = Array.from({ length: 10 }, (_, index) => ({
    id: `knowledge:release:${index}`,
    sourceType: "operating_guidance",
    trust: "untrusted_retrieved_content",
    title: "Approved operating guidance",
    content: "y".repeat(4_000),
    releaseId: "release",
    fragmentId: `fragment-${index}`,
  }));
  const prompt = buildAssistantPromptInput({
    userMessage: user,
    history,
    platformFacts: platformFactsForQuery(user.content),
    operatingGuidance: guidance,
  });

  assert.equal(prompt.schemaVersion, "platform-assistant-prompt.v6");
  assert.equal(prompt.intent.intent, "event_planning");
  assert.equal(prompt.uiContext, null);
  assert.ok(prompt.history.length <= 30);
  assert.ok(
    prompt.history.reduce((total, item) => total + item.content.length, 0) <=
      ASSISTANT_HISTORY_MAX_CHARACTERS,
  );
  assert.ok(
    prompt.evidence.reduce((total, item) => total + item.content.length, 0) <=
      ASSISTANT_EVIDENCE_MAX_CHARACTERS,
  );
  assert.ok(
    prompt.evidence
      .filter((item) => item.sourceType === "operating_guidance")
      .every(
        (item) =>
          item.trust === "untrusted_retrieved_content" &&
          item.content.length <= 3_000,
      ),
  );
  assert.ok(prompt.instructions.some((item) => item.includes("never as instructions")));
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("kind=abstention with citationIds=[]"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("exact href as a Markdown link"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("Resolve follow-up wording"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("exactly one concise sentence") &&
      item.includes("do not re-expand"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("user-operated steps"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("links, pages, or routes mentioned earlier"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("no form-field evidence is supplied") &&
      item.includes("instead of guessing from an earlier topic"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("multiple named statuses") &&
      item.includes("every requested status"),
    ),
  );
  assert.ok(
    prompt.instructions.some((item) =>
      item.includes("where to record general event"),
    ),
  );
});

test("selected proposal instructions distinguish unavailable private data from missing fields", () => {
  assert.ok(
    PLATFORM_ASSISTANT_INSTRUCTIONS.some(
      (instruction) =>
        instruction.includes("Never call privacy-excluded") &&
        instruction.includes("separately after the verified missing-field list"),
    ),
  );
});

test("provider response validation enforces citations and safe internal links", () => {
  const evidence = platformFactsForQuery("Where are proposals?");
  const valid = validateAssistantProviderResponse(
    {
      kind: "answer",
      content: "Open [Proposals](/proposals).",
      citationIds: ["platform:navigation:proposals"],
    },
    evidence,
  );
  assert.equal(valid.citations[0].href, "/proposals");

  const actionEvidence = platformFactsForQuery(
    "Delete my proposal and explain where I should do it.",
  );
  const linked = validateAssistantProviderResponse(
    {
      kind: "refusal",
      content:
        "I can’t delete it. Open [Proposals](/proposals) and use the delete control.",
      citationIds: ["platform:assistant:scope"],
    },
    actionEvidence,
  );
  assert.ok(
    linked.citationIds.includes("platform:navigation:proposals"),
  );
  assert.ok(
    linked.citations.some((citation) => citation.href === "/proposals"),
  );

  const eventEvidence = platformFactsForQuery(
    "The event is next week and venue and budget are not confirmed.",
  );
  const approvedHistoryLink = validateAssistantProviderResponse(
    {
      kind: "answer",
      content:
        "Prioritize venue and budget, then open [Proposals](/proposals).",
      citationIds: ["platform:event:planning-brief"],
    },
    eventEvidence,
  );
  assert.ok(
    approvedHistoryLink.citationIds.includes(
      "platform:navigation:proposals",
    ),
  );

  const maxEvidence = platformFactsForQuery(
    "proposal event venue schedule room hybrid recording technical budget workflow email vendor settings dashboard",
    12,
  );
  const linkedSettings = validateAssistantProviderResponse(
    {
      kind: "answer",
      content: "Open [Settings](/settings).",
      citationIds: maxEvidence.map((item) => item.id),
    },
    maxEvidence,
  );
  assert.equal(linkedSettings.citationIds.length, 12);
  assert.ok(
    linkedSettings.citationIds.includes("platform:navigation:settings"),
  );

  for (const invalid of [
    { kind: "answer", content: "Unsupported.", citationIds: [] },
    { kind: "answer", content: "Unsupported.", citationIds: ["unknown"] },
    {
      kind: "answer",
      content: "Open [external](https://example.com).",
      citationIds: ["platform:navigation:proposals"],
    },
    {
      kind: "answer",
      content: "Open [unapproved](/internal-admin).",
      citationIds: ["platform:navigation:proposals"],
    },
  ]) {
    assert.throws(
      () => validateAssistantProviderResponse(invalid, evidence),
      (error) =>
        error instanceof PlatformAssistantError &&
        error.code === "ASSISTANT_RESPONSE_INVALID",
    );
  }
});

test("validation permits a cited field's exact plain URL example but not an external link", () => {
  const fieldEvidence = proposalFormGuidanceEvidenceForQuery(
    "What should I enter for the Event Website field?",
    1,
  );
  const citationId = fieldEvidence[0]?.id;
  assert.ok(citationId);

  const validated = validateAssistantProviderResponse(
    {
      kind: "answer",
      content:
        "Enter the event's official URL, for example https://example.com/summit2026.",
      citationIds: [citationId],
    },
    fieldEvidence,
  );
  assert.match(validated.content, /https:\/\/example\.com\/summit2026/);

  assert.throws(
    () =>
      validateAssistantProviderResponse(
        {
          kind: "answer",
          content: "Open [the example](https://example.com/summit2026).",
          citationIds: [citationId],
        },
        fieldEvidence,
      ),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RESPONSE_INVALID",
  );
});

test("proposal-specific handoff requires selection and never guesses private context", () => {
  const instructions = PLATFORM_ASSISTANT_INSTRUCTIONS.join("\n");
  assert.match(instructions, /authorized proposal selector/i);
  assert.match(instructions, /Do not ask the user to paste private proposal content/i);
  const fact = PLATFORM_FACTS.find(
    (item) => item.id === "platform:assistant:proposal-workspace",
  );
  assert.ok(fact);
  assert.match(fact.content, /only proposals available to that account/i);
  assert.match(fact.content, /checks access and availability again/i);
  assert.match(fact.content, /unsent browser-session draft/i);
  assert.doesNotMatch(fact.content, /\/proposals\/[0-9a-f]{24}\/assistant/i);
});

test("greeting-only uncited answers normalize without weakening substantive validation", () => {
  const greeting = {
    kind: "answer",
    content: "Hello! How can I help?",
    citationIds: [],
  };
  assert.deepEqual(
    normalizeConversationalAssistantResponse(greeting, "hello"),
    { ...greeting, kind: "clarification" },
  );
  assert.deepEqual(
    normalizeConversationalAssistantResponse(greeting, "হ্যালো!"),
    { ...greeting, kind: "clarification" },
  );
  assert.deepEqual(
    normalizeConversationalAssistantResponse(
      greeting,
      "Explain the proposal workflow.",
    ),
    greeting,
  );
  assert.throws(
    () =>
      validateAssistantProviderResponse(
        normalizeConversationalAssistantResponse(
          greeting,
          "Explain the proposal workflow.",
        ),
        [],
      ),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RESPONSE_INVALID",
  );
});

test("approved knowledge adapter forces operating guidance and degrades safely", async () => {
  let captured;
  const source = createApprovedKnowledgeSource(
    {
      async retrieve(input) {
        captured = input;
        return {
          policyVersion: "policy-v1",
          results: [
            {
              fragmentId: "fragment-1",
              releaseId: "release-1",
              sourceType: "operating_guidance",
              content: "Approved event schedule guidance.",
            },
            {
              fragmentId: "fragment-2",
              releaseId: "release-2",
              sourceType: "price_sheet",
              content: "Must not cross the adapter boundary.",
            },
          ],
        };
      },
    },
    () => true,
  );
  const available = await source.retrieve({
    ...context,
    query: "event schedule",
    limit: 20,
    idempotencyKey: "assistant-knowledge:test",
  });
  assert.deepEqual(captured.filters.sourceTypes, ["operating_guidance"]);
  assert.equal(captured.purpose, "knowledge_retrieval");
  assert.ok(captured.limit <= 8);
  assert.equal(available.status.state, "available");
  assert.equal(available.status.resultCount, 1);
  assert.equal(available.evidence.length, 1);
  assert.equal(available.evidence[0].trust, "untrusted_retrieved_content");
  assert.equal(available.evidence[0].sourceType, "operating_guidance");

  let disabledCalled = false;
  const disabled = createApprovedKnowledgeSource(
    {
      async retrieve() {
        disabledCalled = true;
        throw new Error("must not run");
      },
    },
    () => false,
  );
  const unavailable = await disabled.retrieve({
    ...context,
    query: "event schedule",
    limit: 8,
    idempotencyKey: "assistant-knowledge:disabled",
  });
  assert.equal(disabledCalled, false);
  assert.equal(unavailable.status.state, "unavailable");
  assert.equal(unavailable.status.safeCode, "ASSISTANT_KNOWLEDGE_UNAVAILABLE");
});

test("deterministic guidance fixtures enforce grounding, refusal, and abstention", async () => {
  const provider = new DeterministicAssistantProvider();

  for (const fixture of fixtures) {
    const user = message({ id: `user-${fixture.id}`, content: fixture.query });
    const prompt = buildAssistantPromptInput({
      userMessage: user,
      history: [],
      platformFacts: platformFactsForQuery(fixture.query),
      operatingGuidance: fixture.knowledge,
    });
    const raw = await provider.generate(prompt);
    const validated = validateAssistantProviderResponse(raw, prompt.evidence);

    assert.equal(validated.kind, fixture.expectedKind, fixture.id);
    for (const citationId of fixture.expectedCitationIds) {
      assert.ok(validated.citationIds.includes(citationId), `${fixture.id}:${citationId}`);
    }
    for (const forbidden of fixture.forbiddenText || []) {
      assert.doesNotMatch(validated.content, new RegExp(forbidden, "i"), fixture.id);
    }
  }
});

test("deterministic provider reports exact authorized proposal portfolio counts", async () => {
  const provider = new DeterministicAssistantProvider();
  const evidence = {
    id: "proposal-portfolio:counts",
    sourceType: "proposal_portfolio",
    trust: "authorized_private_data",
    title: "Your proposal counts",
    content: JSON.stringify({
      schemaVersion: "assistant-proposal-portfolio.v1",
      scope: "authenticated_owner_and_organization",
      totalCreated: 83,
      mainList: 68,
      draft: 48,
      live: 4,
      favorite: 0,
      expired: 16,
      archived: 14,
      savedCopies: 1,
    }),
    href: "/proposals",
  };
  const prompt = buildAssistantPromptInput({
    userMessage: message({
      id: "portfolio-count-user",
      content: "How many proposals have I created?",
    }),
    history: [],
    platformFacts: [],
    operatingGuidance: [],
    proposalEvidence: [evidence],
    intent: {
      intent: "proposal_specific_request",
      version: "assistant-intent-router.v2",
      source: "deterministic",
      confidence: "high",
    },
  });

  const response = validateAssistantProviderResponse(
    await provider.generate(prompt),
    prompt.evidence,
  );

  assert.equal(response.kind, "answer");
  assert.match(response.content, /\*\*83 proposals\*\*/);
  assert.match(response.content, /\*\*68\*\*/);
  assert.match(response.content, /\*\*48 drafts\*\*/);
  assert.match(response.content, /\*\*4 live\*\*/);
  assert.match(response.content, /\*\*16 expired\*\*/);
  assert.match(response.content, /\*\*14 archived\*\*/);
  assert.match(response.content, /\*\*1 saved copy\*\*/);
  assert.match(response.content, /\[Open Proposals\]\(\/proposals\)/);
  assert.deepEqual(response.citationIds, ["proposal-portfolio:counts"]);
});

test("deterministic provider answers a requested proposal status count concisely", async () => {
  const provider = new DeterministicAssistantProvider();
  const prompt = buildAssistantPromptInput({
    userMessage: message({
      id: "draft-count-user",
      content: "How many draft proposals do I have?",
    }),
    history: [],
    platformFacts: [],
    operatingGuidance: [],
    proposalEvidence: [
      {
        id: "proposal-portfolio:counts",
        sourceType: "proposal_portfolio",
        trust: "authorized_private_data",
        title: "Your proposal counts",
        content: JSON.stringify({ totalCreated: 83, draft: 48 }),
        href: "/proposals",
      },
    ],
    intent: {
      intent: "proposal_specific_request",
      version: "assistant-intent-router.v2",
      source: "deterministic",
      confidence: "high",
    },
  });

  const response = validateAssistantProviderResponse(
    await provider.generate(prompt),
    prompt.evidence,
  );

  assert.equal(response.kind, "answer");
  assert.match(response.content, /\*\*48 draft proposals\*\*/);
  assert.doesNotMatch(response.content, /current proposal list/i);
  assert.deepEqual(response.citationIds, ["proposal-portfolio:counts"]);
});

test("deterministic provider answers every requested proposal status count", async () => {
  const provider = new DeterministicAssistantProvider();
  const prompt = buildAssistantPromptInput({
    userMessage: message({
      id: "multi-status-count-user",
      content: "How many archived proposals and saved copies do I have?",
    }),
    history: [],
    platformFacts: [],
    operatingGuidance: [],
    proposalEvidence: [
      {
        id: "proposal-portfolio:counts",
        sourceType: "proposal_portfolio",
        trust: "authorized_private_data",
        title: "Your proposal counts",
        content: JSON.stringify({
          totalCreated: 83,
          archived: 14,
          savedCopies: 1,
        }),
        href: "/proposals",
      },
    ],
    intent: {
      intent: "proposal_specific_request",
      version: "assistant-intent-router.v2",
      source: "deterministic",
      confidence: "high",
    },
  });

  const response = validateAssistantProviderResponse(
    await provider.generate(prompt),
    prompt.evidence,
  );

  assert.equal(response.kind, "answer");
  assert.match(response.content, /\*\*14 archived proposals\*\*/);
  assert.match(response.content, /\*\*1 saved copy\*\*/);
  assert.deepEqual(response.citationIds, ["proposal-portfolio:counts"]);
});

test("deterministic formatting keeps authorized proposal-count grounding", async () => {
  const provider = new DeterministicAssistantProvider();
  const prompt = buildAssistantPromptInput({
    userMessage: message({
      id: "count-format-user",
      ordinal: 3,
      content: "Make that answer one short sentence.",
    }),
    history: [
      message({
        id: "count-question-user",
        ordinal: 1,
        content: "How many proposals do I have?",
      }),
      message({
        id: "count-answer-assistant",
        ordinal: 2,
        role: "assistant",
        content: "You have created 83 proposals in total.",
      }),
    ],
    platformFacts: [],
    operatingGuidance: [],
    proposalEvidence: [
      {
        id: "proposal-portfolio:counts",
        sourceType: "proposal_portfolio",
        trust: "authorized_private_data",
        title: "Your proposal counts",
        content: JSON.stringify({ totalCreated: 83 }),
        href: "/proposals",
      },
    ],
    intent: {
      intent: "proposal_specific_request",
      version: "assistant-intent-router.v2",
      source: "follow_up",
      confidence: "medium",
    },
  });

  const response = validateAssistantProviderResponse(
    await provider.generate(prompt),
    prompt.evidence,
  );

  assert.equal(response.kind, "answer");
  assert.equal(response.content, "You have created 83 proposals in total.");
  assert.equal(response.content.match(/[.!?]/g)?.length, 1);
  assert.deepEqual(response.citationIds, ["proposal-portfolio:counts"]);
});

test("deterministic fallback explains the guided intake and safe manual action paths", async () => {
  const provider = new DeterministicAssistantProvider();

  const createUser = message({
    id: "create-user",
    content: "How do I create a proposal? Explain the form steps.",
  });
  const createPrompt = buildAssistantPromptInput({
    userMessage: createUser,
    history: [],
    platformFacts: platformFactsForQuery(createUser.content),
    operatingGuidance: [],
  });
  const createResponse = validateAssistantProviderResponse(
    await provider.generate(createPrompt),
    createPrompt.evidence,
  );
  assert.equal(createResponse.kind, "answer");
  assert.match(createResponse.content, /Event Overview/);
  assert.match(createResponse.content, /Room Specifications;/);
  assert.doesNotMatch(createResponse.content, /Content & Creative; Video Recording;/);
  assert.match(createResponse.content, /Contact & Submit/);
  assert.match(createResponse.content, /\/proposals\/add-new-proposal/);

  const actionUser = message({
    id: "action-user",
    content: "Can you create, publish, and email the proposal for me?",
  });
  const actionPrompt = buildAssistantPromptInput({
    userMessage: actionUser,
    history: [],
    platformFacts: platformFactsForQuery(actionUser.content),
    operatingGuidance: [],
  });
  const actionResponse = validateAssistantProviderResponse(
    await provider.generate(actionPrompt),
    actionPrompt.evidence,
  );
  assert.equal(actionResponse.kind, "refusal");
  assert.match(actionResponse.content, /can’t create, publish, or email/i);
  assert.match(actionResponse.content, /\/proposals\/add-new-proposal/);
  assert.match(actionResponse.content, /\/email/);

  const deleteUser = message({
    id: "delete-user",
    content: "Delete my latest proposal and confirm when it is done.",
  });
  const deletePrompt = buildAssistantPromptInput({
    userMessage: deleteUser,
    history: [],
    platformFacts: platformFactsForQuery(deleteUser.content),
    operatingGuidance: [],
  });
  const deleteResponse = validateAssistantProviderResponse(
    await provider.generate(deletePrompt),
    deletePrompt.evidence,
  );
  assert.equal(deleteResponse.kind, "refusal");
  assert.match(deleteResponse.content, /trash\/delete control/i);
  assert.match(deleteResponse.content, /\/proposals/);

  const priorAssistant = message({
    id: "prior-assistant",
    ordinal: 2,
    role: "assistant",
    content:
      "Top items:\n- Confirm budget\n- Confirm venue\n- Lock dates\n- Define room scope\n- Confirm AV needs",
  });
  const formatUser = message({
    id: "format-user",
    ordinal: 3,
    content: "Make that answer shorter and use bullets.",
  });
  const formatPrompt = buildAssistantPromptInput({
    userMessage: formatUser,
    history: [
      message({
        id: "prior-user",
        ordinal: 1,
        content: "What should I prioritize for this event?",
      }),
      priorAssistant,
    ],
    platformFacts: platformFactsForQuery(
      "event budget venue dates room AV checklist",
    ),
    operatingGuidance: [],
  });
  const formatResponse = validateAssistantProviderResponse(
    await provider.generate(formatPrompt),
    formatPrompt.evidence,
  );
  assert.equal(formatResponse.kind, "answer");
  assert.match(formatResponse.content, /^-\s+Confirm budget/m);
  assert.doesNotMatch(formatResponse.content, /enough approved/i);

  const bookingUser = message({
    id: "booking-user",
    content: "Book a venue for 1,500 attendees.",
  });
  const bookingPrompt = buildAssistantPromptInput({
    userMessage: bookingUser,
    history: [],
    platformFacts: platformFactsForQuery(bookingUser.content),
    operatingGuidance: [],
  });
  const bookingResponse = validateAssistantProviderResponse(
    await provider.generate(bookingPrompt),
    bookingPrompt.evidence,
  );
  assert.equal(bookingResponse.kind, "refusal");
  assert.match(bookingResponse.content, /can’t book or reserve/i);
  assert.match(bookingResponse.content, /\/proposals\/add-new-proposal/);
});

test("non-streaming application completes from platform facts when knowledge is unavailable", async () => {
  const calls = [];
  const user = message({ content: "Explain the proposal workflow." });
  const pending = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "",
    status: "pending",
    completedAt: null,
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      calls.push("get");
      return { thread, messages: [user, pending] };
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      calls.push("append-user");
      return { created: true, message: user };
    },
    async createAssistantMessage() {
      calls.push("create-assistant");
      return { created: true, message: pending };
    },
    async updateAssistantMessage(input) {
      calls.push(`update-${input.status}`);
      return message({
        ...pending,
        role: "assistant",
        content: input.content,
        status: input.status,
        model: input.model || null,
        safeErrorCode: input.safeErrorCode || null,
        citations: input.citations || [],
        completedAt: "2026-07-26T00:00:01.000Z",
      });
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        calls.push("knowledge");
        return {
          status: {
            state: "unavailable",
            safeCode: "ASSISTANT_KNOWLEDGE_UNAVAILABLE",
            diagnosticCode: "KNOWLEDGE_RETRIEVAL_DISABLED",
          },
          evidence: [],
        };
      },
    },
    responseProvider: new DeterministicAssistantProvider(),
  });

  const output = await withEnabledAssistant(() =>
    application.generateGuidance(context, {
      threadId,
      body: { content: user.content },
      idempotencyKey: "message-guidance-1",
    }),
  );
  assert.deepEqual(calls, [
    "append-user",
    "create-assistant",
    "knowledge",
    "get",
    "update-complete",
  ]);
  assert.equal(output.knowledge.state, "unavailable");
  assert.equal(output.assistantMessage.status, "complete");
  assert.ok(output.assistantMessage.citations.length >= 1);
});

test("non-streaming application does not regenerate an idempotent assistant response", async () => {
  let knowledgeCalls = 0;
  let providerCalls = 0;
  const user = message();
  const complete = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "Existing response",
    status: "complete",
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      throw new Error("must not run");
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      return { created: false, message: user };
    },
    async createAssistantMessage() {
      return { created: false, message: complete };
    },
    async updateAssistantMessage() {
      throw new Error("must not run");
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        knowledgeCalls += 1;
        throw new Error("must not run");
      },
    },
    responseProvider: {
      provider: "mock",
      model: "test",
      async generate() {
        providerCalls += 1;
        throw new Error("must not run");
      },
    },
  });

  const output = await withEnabledAssistant(() =>
    application.generateGuidance(context, {
      threadId,
      body: { content: user.content },
      idempotencyKey: "message-guidance-replay",
    }),
  );
  assert.equal(output.assistantMessage.id, complete.id);
  assert.equal(output.knowledge.state, "not_requested");
  assert.equal(knowledgeCalls, 0);
  assert.equal(providerCalls, 0);
});

test("invalid provider output marks the pending assistant row failed", async () => {
  const statuses = [];
  const user = message();
  const pending = message({
    id: "01890b2e-58b1-7c7e-9b0a-1a2b3c4d5e71",
    ordinal: 2,
    role: "assistant",
    content: "",
    status: "pending",
    completedAt: null,
  });
  const repository = {
    async createThread() {
      throw new Error("not used");
    },
    async listThreads() {
      return [];
    },
    async getThread() {
      return { thread, messages: [user, pending] };
    },
    async archiveThread() {
      throw new Error("not used");
    },
    async appendUserMessage() {
      return { created: true, message: user };
    },
    async createAssistantMessage() {
      return { created: true, message: pending };
    },
    async updateAssistantMessage(input) {
      statuses.push([input.status, input.safeErrorCode]);
      return message({ ...pending, status: input.status });
    },
  };
  const application = createPlatformAssistantApplication(repository, {
    knowledgeSource: {
      async retrieve() {
        return {
          status: { state: "available", policyVersion: "test", resultCount: 0 },
          evidence: [],
        };
      },
    },
    responseProvider: {
      provider: "mock",
      model: "invalid-test",
      async generate() {
        return {
          kind: "answer",
          content: "This citation was not supplied.",
          citationIds: ["unknown"],
        };
      },
    },
  });

  await assert.rejects(
    withEnabledAssistant(() =>
      application.generateGuidance(context, {
        threadId,
        body: { content: user.content },
        idempotencyKey: "message-guidance-invalid",
      }),
    ),
    (error) =>
      error instanceof PlatformAssistantError &&
      error.code === "ASSISTANT_RESPONSE_INVALID",
  );
  assert.deepEqual(statuses, [["failed", "ASSISTANT_RESPONSE_INVALID"]]);
});
