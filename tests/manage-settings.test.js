const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createDeleteOwnedSettings,
  createGetOwnedSettings,
  createUpdateOwnedSettings,
} = require("../src/modules/settings/application/manageSettings");

test("settings retrieval and deletion preserve authenticated owner context", async () => {
  const calls = [];
  const repository = {
    findOrCreateByUserId: async (userId) => {
      calls.push({ action: "get", userId });
      return { userId, branding: {} };
    },
    upsertByUserId: async () => ({}),
    deleteByUserId: async (userId) => {
      calls.push({ action: "delete", userId });
      return true;
    },
  };

  await createGetOwnedSettings(repository)("user-001");
  assert.equal(await createDeleteOwnedSettings(repository)("user-001"), true);
  assert.deepEqual(calls, [
    { action: "get", userId: "user-001" },
    { action: "delete", userId: "user-001" },
  ]);
});

test("settings update strips system fields and browser-only logo URLs", async () => {
  let upsert;
  let uploads = 0;
  const update = createUpdateOwnedSettings({
    folderName: "",
    repository: {
      findOrCreateByUserId: async () => ({}),
      upsertByUserId: async (input) => {
        upsert = input;
        return input.updates;
      },
      deleteByUserId: async () => false,
    },
    storage: {
      upload: async () => {
        uploads += 1;
        return "unused";
      },
    },
  });

  await update({
    userId: "user-001",
    settings: {
      _id: "client-id",
      userId: "other-user",
      createdAt: "yesterday",
      branding: { brandName: "DXG", logoFile: "blob:browser-preview" },
      proposals: { proposalLanguage: "English" },
    },
  });

  assert.deepEqual(upsert, {
    userId: "user-001",
    updates: {
      branding: { brandName: "DXG" },
      proposals: { proposalLanguage: "English" },
    },
  });
  assert.equal(uploads, 0);
});

test("uploaded logo uses normalized owner-scoped object key", async () => {
  let storageInput;
  let upsert;
  const update = createUpdateOwnedSettings({
    folderName: "/DXG-RFP-Tool/",
    now: () => 987654,
    repository: {
      findOrCreateByUserId: async () => ({}),
      upsertByUserId: async (input) => {
        upsert = input;
        return input.updates;
      },
      deleteByUserId: async () => false,
    },
    storage: {
      upload: async (input) => {
        storageInput = input;
        return "https://storage.example/logo.svg";
      },
    },
  });

  await update({
    userId: "user-001",
    settings: { branding: { brandName: "DXG" } },
    logo: { originalname: "Company.Logo.SVG", path: "/tmp/logo-upload" },
  });

  assert.deepEqual(storageInput, {
    localPath: "/tmp/logo-upload",
    objectKey: "DXG-RFP-Tool/settings/user-001/logo-987654.svg",
  });
  assert.deepEqual(upsert.updates.branding, {
    brandName: "DXG",
    logoFile: "https://storage.example/logo.svg",
  });
});

test("data URL is rejected even when no other branding field remains", async () => {
  let updates;
  const update = createUpdateOwnedSettings({
    folderName: "",
    repository: {
      findOrCreateByUserId: async () => ({}),
      upsertByUserId: async (input) => {
        updates = input.updates;
        return updates;
      },
      deleteByUserId: async () => false,
    },
    storage: { upload: async () => "unused" },
  });

  await update({
    userId: "user-001",
    settings: { branding: { logoFile: "data:image/png;base64,abc" } },
  });

  assert.deepEqual(updates, { branding: {} });
});
