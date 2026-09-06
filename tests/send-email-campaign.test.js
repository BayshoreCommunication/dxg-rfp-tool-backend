const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSendOwnedEmailCampaign,
} = require("../src/modules/email/application/sendEmailCampaign");

const dependencies = (capture = {}) => {
  let tracking = 0;
  return {
    frontendBaseUrl: "https://app.example.com/",
    apiBaseUrl: "https://api.example.com/",
    trackingId: () => `tracking-${++tracking}`,
    now: () => new Date("2026-07-16T13:00:00.000Z"),
    repository: {
      findOwnedProposal: async (input) => {
        capture.proposalLookup = input;
        return { proposalId: input.proposalId, proposalTitle: "DXG Summit" };
      },
      createCampaign: async (input) => {
        capture.created = input;
        return { campaignId: "campaign-001" };
      },
      finalizeCampaign: async (input) => {
        capture.finalized = input;
        return { _id: input.campaignId, recipients: input.recipients };
      },
    },
    delivery: {
      send: async (input) => {
        capture.deliveries = [...(capture.deliveries ?? []), input];
      },
    },
  };
};

test("campaign validation stops before proposal lookup", async () => {
  const capture = {};
  const send = createSendOwnedEmailCampaign(dependencies(capture));

  assert.deepEqual(
    await send({ ownerUserId: "user-001", recipientEmails: [] }),
    { kind: "proposal_id_required" },
  );
  assert.deepEqual(
    await send({
      ownerUserId: "user-001",
      proposalId: "proposal-001",
      recipientEmails: ["invalid"],
    }),
    { kind: "recipients_required" },
  );
  assert.equal(capture.proposalLookup, undefined);
});

test("campaign sending normalizes recipients and enforces proposal ownership", async () => {
  const capture = {};
  const send = createSendOwnedEmailCampaign(dependencies(capture));

  const result = await send({
    ownerUserId: "user-001",
    proposalId: "proposal-001",
    recipientEmails: [
      " SALES@EXAMPLE.COM ",
      "sales@example.com",
      "invalid",
      42,
    ],
    message: "Please review.\nProposal link: unsafe duplicate\nThank you.",
  });

  assert.deepEqual(capture.proposalLookup, {
    proposalId: "proposal-001",
    ownerUserId: "user-001",
  });
  assert.equal(capture.created.recipients.length, 1);
  assert.equal(capture.created.recipients[0].email, "sales@example.com");
  assert.equal(capture.created.message, "Please review.\nThank you.");
  assert.equal(result.kind, "processed");
  assert.equal(result.sentCount, 1);
});

test("delivery content contains encoded tracking URLs and escaped message", async () => {
  const capture = {};
  const send = createSendOwnedEmailCampaign(dependencies(capture));

  await send({
    ownerUserId: "user-001",
    proposalId: "507f1f77bcf86cd799439011",
    recipientEmails: ["vendor@example.com"],
    message: "Review <script>alert(1)</script>",
  });

  const delivery = capture.deliveries[0];
  assert.match(delivery.html, /Review &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(delivery.html, /https:\/\/api\.example\.com\/api\/emails\/open\/tracking-1/);
  assert.match(delivery.html, /vendor-click\/tracking-1\?redirect=/);
  assert.match(delivery.text, /https:\/\/app\.example\.com\/proposal-view\/dxg-summit-/);
  assert.match(delivery.html, /Submit Your Proposal<\/a>/);
  assert.match(delivery.text, /Give feedback: https:\/\/app\.example\.com\/vendor-response\/dxg-summit-/);
  assert.ok(
    delivery.html.indexOf("Submit Your Proposal") <
      delivery.html.indexOf("If the button does not work"),
  );
});

test("partial delivery persists every outcome and reports failures", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.delivery.send = async (input) => {
    if (input.to === "failed@example.com") throw new Error("SMTP rejected");
    capture.deliveries = [...(capture.deliveries ?? []), input];
  };
  const send = createSendOwnedEmailCampaign(deps);

  const result = await send({
    ownerUserId: "user-001",
    proposalId: "proposal-001",
    recipientEmails: ["ok@example.com", "failed@example.com"],
  });

  assert.equal(result.kind, "processed");
  assert.equal(result.sentCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.failedRecipients, [
    { email: "failed@example.com", errorMessage: "SMTP rejected" },
  ]);
  assert.equal(capture.finalized.ownerUserId, "user-001");
  assert.equal(capture.finalized.recipients[0].status, "sent");
  assert.equal(capture.finalized.recipients[1].status, "failed");
});

test("all failed deliveries return typed gateway-failure outcome", async () => {
  const capture = {};
  const deps = dependencies(capture);
  deps.delivery.send = async () => {
    throw new Error("SMTP unavailable");
  };
  const send = createSendOwnedEmailCampaign(deps);

  const result = await send({
    ownerUserId: "user-001",
    proposalId: "proposal-001",
    recipientEmails: ["vendor@example.com"],
  });

  assert.equal(result.kind, "all_failed");
  assert.equal(result.sentCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(capture.finalized.sentCount, 0);
});

test("a vendor question goes out as a plain email without proposal or submission links", async () => {
  const capture = {};
  const send = createSendOwnedEmailCampaign(dependencies(capture));
  const result = await send({
    ownerUserId: "user-001",
    proposalId: "proposal-001",
    recipientEmails: ["vendor@example.com"],
    subject: "Questions about your response to DXG Summit",
    message: "We could not find answers to:\n- Union Labor",
    kind: "question",
  });
  assert.equal(result.kind, "processed");
  assert.equal(capture.deliveries.length, 1);
  const [delivery] = capture.deliveries;
  assert.equal(delivery.subject, "Questions about your response to DXG Summit");
  assert.match(delivery.html, /A question about your response to/);
  assert.match(delivery.html, /Union Labor/);
  assert.match(delivery.html, /Reply to this email to answer/);
  assert.doesNotMatch(delivery.html, /Submit Your Proposal|View Proposal|accessGrant|vendor-response\//);
  assert.doesNotMatch(delivery.text, /View proposal|Give feedback/);
  // Open tracking stays so the planner can see it was read.
  assert.match(delivery.html, /api\/emails\/open\/tracking-1/);
  assert.equal(capture.finalized.sentCount, 1);
});

test("a vendor question with no subject gets a question subject, not an invitation one", async () => {
  const capture = {};
  const send = createSendOwnedEmailCampaign(dependencies(capture));
  await send({ ownerUserId: "user-001", proposalId: "proposal-001", recipientEmails: ["vendor@example.com"], message: "Hi", kind: "question" });
  assert.equal(capture.deliveries[0].subject, "A question about your response to DXG Summit");
  await send({ ownerUserId: "user-001", proposalId: "proposal-001", recipientEmails: ["vendor@example.com"], message: "Hi" });
  assert.equal(capture.deliveries[1].subject, "Proposal for DXG Summit - DXG RFP Tool");
  assert.match(capture.deliveries[1].html, /Submit Your Proposal/);
});
