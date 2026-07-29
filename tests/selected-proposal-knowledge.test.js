const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildSelectedProposalKnowledge,
  MAX_SELECTED_PROPOSAL_KNOWLEDGE_CHARACTERS,
  SELECTED_PROPOSAL_KNOWLEDGE_VERSION,
} = require("../src/modules/conversations/selectedProposalKnowledge");

const root = path.join(__dirname, "..");

test("selected proposal knowledge exposes only bounded planning sections", () => {
  const snapshot = buildSelectedProposalKnowledge({
    version: 7,
    status: "submitted",
    isDraft: false,
    event: {
      eventName: "Annual Summit",
      attendees: "1500",
      eventFormat: "Hybrid",
    },
    venueSchedule: {
      venueCity: "Chicago",
      numberOfEventRooms: "4",
    },
    roomByRoom: [
      { roomName: "Ballroom", capacity: "900" },
      { roomName: "Breakout A", capacity: "300" },
    ],
    production: { audio: "Line array", lighting: "Keynote wash" },
    hybridVirtual: { streamingPlatform: "Zoom Webinar" },
    contentCreative: { presentationManagement: "Required" },
    videoRecordingStep: { videoRecordingRequired: "YES" },
    venue: { riggingRequired: "YES" },
    budget: { budgetTier: "$250k-$500k" },
    contact: { contactEmail: "private@example.test" },
    uploads: { storageKey: "secret-object-key" },
  });

  assert.equal(snapshot.schemaVersion, SELECTED_PROPOSAL_KNOWLEDGE_VERSION);
  assert.equal(snapshot.selection, "explicit_owner_authorized");
  assert.equal(snapshot.proposalVersion, 7);
  assert.deepEqual(snapshot.lifecycle, { status: "submitted", draft: false });
  assert.equal(snapshot.sections.event.eventName, "Annual Summit");
  assert.equal(snapshot.sections.venueSchedule.numberOfEventRooms, "4");
  assert.equal(snapshot.sections.roomByRoom.length, 2);
  assert.equal(snapshot.sections.production.audio, "Line array");
  assert.equal(snapshot.sections.hybridVirtual.streamingPlatform, "Zoom Webinar");
  assert.equal(snapshot.sections.contentCreative.presentationManagement, "Required");
  assert.equal(snapshot.sections.videoRecordingStep.videoRecordingRequired, "YES");
  assert.equal(snapshot.sections.venue.riggingRequired, "YES");
  assert.equal(snapshot.sections.budget.budgetTier, "$250k-$500k");
  assert.equal("contact" in snapshot.sections, false);
  assert.equal("uploads" in snapshot.sections, false);
});

test("selected proposal knowledge strips nested contacts, notes, storage keys, and ids", () => {
  const snapshot = buildSelectedProposalKnowledge({
    event: {
      eventName: "Safe Event",
      contactEmail: "person@example.test",
      nested: {
        privateNotes: "Never expose",
        sourceId: "source-secret",
        storageObjectKey: "bucket-secret",
        password: "credential-secret",
        usefulField: "Keep this",
      },
    },
    venue: {
      venueName: "Convention Center",
      venueContactName: "Private Person",
      contactPhone: "+1 555 0100",
      notes: "Private venue note",
    },
    roomByRoom: [
      {
        roomName: "Main Hall",
        internalNotes: "Private room note",
        attachmentObjectKey: "private-key",
      },
    ],
  });
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.sections.event.nested.usefulField, "Keep this");
  assert.equal(snapshot.sections.venue.venueName, "Convention Center");
  for (const secret of [
    "person@example.test",
    "Never expose",
    "source-secret",
    "bucket-secret",
    "credential-secret",
    "Private Person",
    "+1 555 0100",
    "Private venue note",
    "Private room note",
    "private-key",
  ])
    assert.equal(serialized.includes(secret), false, secret);
});

test("selected proposal knowledge caps depth, arrays, strings, and serialized size", () => {
  const snapshot = buildSelectedProposalKnowledge({
    event: {
      eventName: "x".repeat(2_000),
      deep: { one: { two: { three: { four: { five: { six: "too deep" } } } } } },
    },
    roomByRoom: Array.from({ length: 50 }, (_, index) => ({
      roomName: `Room ${index}`,
      description: "y".repeat(2_000),
    })),
    production: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `field${index}`,
        "z".repeat(2_000),
      ]),
    ),
  });

  assert.equal(snapshot.sections.event.eventName.length, 800);
  assert.equal(snapshot.sections.roomByRoom.length, 20);
  assert.equal(
    JSON.stringify(snapshot).includes("too deep"),
    false,
  );
  assert.ok(
    JSON.stringify(snapshot).length <=
      MAX_SELECTED_PROPOSAL_KNOWLEDGE_CHARACTERS + 1_500,
  );
});

test("proposal chat revalidates ownership and tenant before selecting only approved fields", () => {
  const source = fs.readFileSync(
    path.join(root, "src/modules/conversations/chatReply.ts"),
    "utf8",
  );
  for (const guard of [
    "userId: ctx.actorUserMongoId",
    "organizationId: ctx.organizationMongoId",
    "isArchived: { $ne: true }",
    "buildSelectedProposalKnowledge",
  ])
    assert.ok(source.includes(guard), guard);
  assert.equal(
    source.includes("isActive: { $ne: false }"),
    false,
    "selected unsubmitted drafts must provide their saved planning fields",
  );

  const projection = source.match(/\.select\(\s*"([^"]+)"\s*,?\s*\)/s);
  assert.ok(projection, "proposal chat must use an explicit Mongo projection");
  const selected = new Set(projection[1].split(/\s+/));
  for (const field of [
    "status",
    "isDraft",
    "version",
    "event",
    "venueSchedule",
    "roomByRoom",
    "production",
    "hybridVirtual",
    "contentCreative",
    "videoRecordingStep",
    "venue",
    "budget",
  ])
    assert.equal(selected.has(field), true, field);
  for (const forbidden of [
    "contact",
    "uploads",
    "proposalSettings",
    "candidateApplicationIds",
  ])
    assert.equal(selected.has(forbidden), false, forbidden);
});

test("live proposal chat treats the selected snapshot as temporary untrusted evidence", () => {
  const source = fs.readFileSync(
    path.join(root, "src/modules/liveAi/operations.ts"),
    "utf8",
  );
  for (const rule of [
    "fresh, owner-authorized, privacy-filtered snapshot",
    "saved fields",
    "missing or excluded",
    "learned, trained on, or permanently remembered",
    "untrusted data",
    "Never invent event facts",
  ])
    assert.ok(source.includes(rule), rule);
});
