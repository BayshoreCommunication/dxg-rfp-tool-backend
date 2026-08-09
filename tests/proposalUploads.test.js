const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ProposalFileUploadError,
  createUploadProposalFiles,
} = require("../src/modules/proposals/application/uploadProposalFiles");
const {
  redactProposalForPublicView,
} = require("../src/modules/proposals/infrastructure/mongo/mongoPublicProposalAccessRepository");

test("proposal uploads are scanned before private storage", async () => {
  const stored = [];
  const upload = createUploadProposalFiles({
    folderName: "rfp",
    malwareScan: async () => "clean",
    storage: {
      upload: async ({ objectKey }) => {
        stored.push(objectKey);
        return `https://private.example/${objectKey}`;
      },
    },
    now: () => 123,
  });

  const result = await upload({
    ownerUserId: "user-1",
    files: [{
      fieldname: "scenicInspirationFiles",
      originalname: "mood board.pdf",
      path: "/tmp/mood-board.pdf",
    }],
  });

  assert.equal(result.kind, "uploaded");
  assert.deepEqual(stored, ["rfp/proposal-files-private/user-1/123-0-mood_board.pdf"]);
  assert.equal(result.files[0].fieldname, "scenicInspirationFiles");
});

test("proposal uploads fail closed when malware scanning is unavailable", async () => {
  const upload = createUploadProposalFiles({
    folderName: "rfp",
    malwareScan: async () => "unavailable",
    storage: { upload: async () => "should-not-upload" },
  });

  await assert.rejects(
    upload({
      ownerUserId: "user-1",
      files: [{ fieldname: "venueCoiFiles", originalname: "coi.pdf", path: "/tmp/coi.pdf" }],
    }),
    (error) => error instanceof ProposalFileUploadError && error.code === "MALWARE_SCAN_UNAVAILABLE",
  );
});

test("public proposals keep categorized filenames but redact private URLs", () => {
  const result = redactProposalForPublicView({
    userId: "private-user",
    uploads: {
      scenicInspirationFiles: ["https://private.example/rfp/proposal-files-private/user-1/123-0-mood_board.pdf"],
      venueCoiFiles: ["https://private.example/rfp/proposal-files-private/user-1/124-0-venue_coi.pdf"],
      referenceFiles: ["legacy-reference.pdf"],
    },
  });

  assert.equal(result.userId, undefined);
  assert.deepEqual(result.uploads, {
    scenicInspirationFiles: ["mood_board.pdf"],
    venueCoiFiles: ["venue_coi.pdf"],
    referenceFiles: ["legacy-reference.pdf"],
  });
});
