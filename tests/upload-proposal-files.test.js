const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createUploadProposalFiles,
} = require("../src/modules/proposals/application/uploadProposalFiles");

test("empty proposal upload returns a typed no-files result", async () => {
  let uploads = 0;
  const upload = createUploadProposalFiles({
    folderName: "DXG",
    storage: {
      upload: async () => {
        uploads += 1;
        return "unused";
      },
    },
  });

  assert.deepEqual(
    await upload({ ownerUserId: "user-001", files: [] }),
    { kind: "no_files" },
  );
  assert.equal(uploads, 0);
});

test("proposal uploads are owner-scoped and object names are sanitized", async () => {
  const calls = [];
  const upload = createUploadProposalFiles({
    folderName: "DXG-RFP-Tool",
    now: () => 123456,
    malwareScan: async () => "clean",
    storage: {
      upload: async (input) => {
        calls.push(input);
        return `https://storage.example/${input.objectKey}`;
      },
    },
  });

  const result = await upload({
    ownerUserId: "user-001",
    files: [
      {
        fieldname: "brief",
        originalname: "client brief (final).pdf",
        path: "/tmp/upload-a",
      },
      {
        fieldname: "budget",
        originalname: "budget/../../secret.xlsx",
        path: "/tmp/upload-b",
      },
    ],
  });

  assert.deepEqual(calls, [
    {
      localPath: "/tmp/upload-a",
      objectKey:
        "DXG-RFP-Tool/proposal-files-private/user-001/123456-0-client_brief__final_.pdf",
    },
    {
      localPath: "/tmp/upload-b",
      objectKey:
        "DXG-RFP-Tool/proposal-files-private/user-001/123456-1-budget_.._.._secret.xlsx",
    },
  ]);
  assert.equal(result.kind, "uploaded");
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].originalname, "client brief (final).pdf");
});

const fs = require("node:fs"), path = require("node:path");
const {
  createPresignProposalFile,
  ownerUserIdFromObjectKey,
  ProposalFileAccessError,
  PROPOSAL_FILE_PRIVATE_SEGMENT,
} = require("../src/modules/proposals/application/proposalFileAccess");

test("uploaded proposal files are stored privately under their owner", async () => {
  // Support documents and AV quotes are the planner's own commercial material —
  // floor plans, prior proposals, budgets — and were uploaded with a
  // public-read ACL, so the object URL alone read them with no authentication.
  const storage = fs.readFileSync(
    path.join(__dirname, "..", "src/modules/proposals/infrastructure/storage/spacesProposalFileStorage.ts"),
    "utf8",
  );
  assert.match(storage, /return uploadPrivateToSpaces\(/, "stored without the public-read ACL");
  assert.ok(!/"public-read"/.test(storage), "the ACL argument is gone, not just unused");

  const keys = [];
  const upload = createUploadProposalFiles({
    folderName: "DXG",
    now: () => 1700000000000,
    malwareScan: async () => "clean",
    storage: { upload: async ({ objectKey }) => { keys.push(objectKey); return `https://b.r.digitaloceanspaces.com/${objectKey}`; } },
  });
  await upload({ ownerUserId: "user-001", files: [{ fieldname: "supportDocuments", originalname: "floor plan.pdf", path: "/tmp/a" }] });

  // The owner id is part of the key, which is what makes the presign check
  // below an ownership check rather than a formality.
  assert.equal(keys[0], `DXG/${PROPOSAL_FILE_PRIVATE_SEGMENT}/user-001/1700000000000-0-floor_plan.pdf`);
  assert.equal(ownerUserIdFromObjectKey(keys[0]), "user-001");
});

test("a proposal file link is only presigned for the owner of the object", async () => {
  const presign = createPresignProposalFile({
    objectKeyFromUrl: (url) => new URL(url).pathname.replace(/^\/+/, ""),
    presign: async (objectKey, seconds) => `signed:${objectKey}:${seconds}`,
  });
  const url = (owner) => `https://b.r.digitaloceanspaces.com/DXG/${PROPOSAL_FILE_PRIVATE_SEGMENT}/${owner}/file.pdf`;

  const mine = await presign({ requesterUserId: "user-001", url: url("user-001") });
  assert.match(mine.url, /^signed:DXG\/proposal-files-private\/user-001\/file\.pdf:900$/);

  // Without this the endpoint would presign any object in the bucket for any
  // signed-in user, which is a worse leak than the ACL it replaces.
  await assert.rejects(
    () => presign({ requesterUserId: "user-002", url: url("user-001") }),
    (error) => error instanceof ProposalFileAccessError && error.code === "PROPOSAL_FILE_FORBIDDEN" && error.status === 403,
  );

  // Objects uploaded before this change are still world-readable; returning
  // them unchanged is honest, presigning them would imply protection they lack.
  const legacy = "https://b.r.digitaloceanspaces.com/DXG/proposals/user-001/file.pdf";
  assert.deepEqual(await presign({ requesterUserId: "user-002", url: legacy }), { url: legacy });

  await assert.rejects(
    () => presign({ requesterUserId: "user-001", url: "  " }),
    (error) => error.code === "PROPOSAL_FILE_URL_REQUIRED" && error.status === 400,
  );
});

test("the presign route is registered before the :id route that would shadow it", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "routes/proposalsRoute.ts"), "utf8");
  const fileUrl = route.indexOf('router.get("/file-url"');
  const byId = route.indexOf('router.get("/:id"');
  assert.ok(fileUrl > 0 && byId > 0 && fileUrl < byId, "/file-url must not be matched as an id");
  assert.match(route.slice(fileUrl, fileUrl + 200), /authenticate, authorizeAction\("proposal:read"\)/);
});
