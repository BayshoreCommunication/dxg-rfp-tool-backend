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
        "DXG-RFP-Tool/proposals/user-001/123456-0-client_brief__final_.pdf",
    },
    {
      localPath: "/tmp/upload-b",
      objectKey:
        "DXG-RFP-Tool/proposals/user-001/123456-1-budget_.._.._secret.xlsx",
    },
  ]);
  assert.equal(result.kind, "uploaded");
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].originalname, "client brief (final).pdf");
});
