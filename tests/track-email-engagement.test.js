const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTrackEmailOpen,
  createTrackProposalClick,
  createTrackVendorResponseClick,
} = require("../src/modules/email/application/trackEmailEngagement");

test("email open forwards tracking id and deterministic timestamp", async () => {
  let repositoryInput;
  const occurredAt = new Date("2026-07-16T12:00:00.000Z");
  const track = createTrackEmailOpen({
    now: () => occurredAt,
    repository: {
      markOpenedOnce: async (input) => {
        repositoryInput = input;
      },
    },
  });

  await track("tracking-001");

  assert.deepEqual(repositoryInput, { trackingId: "tracking-001", occurredAt });
});

test("tracked proposal click uses campaign slug and ignores supplied redirect", async () => {
  let repositoryInput;
  const track = createTrackProposalClick({
    frontendBaseUrl: "https://app.example.com/",
    repository: {
      markProposalClickedOnce: async (input) => {
        repositoryInput = input;
        return { proposalSlug: "annual-summit-123" };
      },
    },
  });

  const redirect = await track({
    trackingId: "tracking-001",
    fallbackRedirect: "https://attacker.example/redirect",
  });

  assert.equal(repositoryInput.trackingId, "tracking-001");
  assert.equal(
    redirect,
    "https://app.example.com/proposal-view/annual-summit-123?source=email",
  );
});

test("unmatched click only accepts HTTP fallback URLs", async () => {
  const track = createTrackProposalClick({
    frontendBaseUrl: "https://app.example.com",
    repository: { markProposalClickedOnce: async () => null },
  });

  assert.equal(
    await track({ trackingId: "missing", fallbackRedirect: "javascript:alert(1)" }),
    "https://app.example.com",
  );
  assert.equal(
    await track({ trackingId: "missing", fallbackRedirect: "https://safe.example/x" }),
    "https://safe.example/x",
  );
});

test("vendor-response click adds encoded recipient and tracking context", async () => {
  const track = createTrackVendorResponseClick({
    frontendBaseUrl: "https://app.example.com",
    repository: {
      markVendorResponseClickedOnce: async () => ({
        proposalSlug: "annual-summit-123",
        recipientEmail: "vendor+sales@example.com",
      }),
    },
  });

  const redirect = await track({ trackingId: "tracking id/001" });

  assert.equal(
    redirect,
    "https://app.example.com/vendor-response/annual-summit-123?source=email&email=vendor%2Bsales%40example.com&tid=tracking%20id%2F001",
  );
});
