const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createGetAdminSelfProfile,
  createUpdateAdminSelfProfile,
} = require("../src/modules/admin/application/manageAdminSelfProfile");

const dependencies = (overrides = {}) => ({
  repository: {
    async findCredentials() { return { passwordHash: "stored" }; },
    async update(_id, patch) { return { id: "a1", ...patch }; },
  },
  avatars: { async upload() { throw new Error("unexpected upload"); } },
  passwords: { async hash() { throw new Error("unexpected hash"); } },
  passwordVerifier: { async verify() { throw new Error("unexpected verify"); } },
  timestamps: { nowMs: () => 1234 },
  storageFolder: "tenant-assets",
  ...overrides,
});

test("admin self-profile read delegates authenticated identifier", async () => {
  let received;
  const get = createGetAdminSelfProfile({
    async findSafe(id) { received = id; return { id }; },
  });
  assert.deepEqual(await get("a1"), { id: "a1" });
  assert.equal(received, "a1");
});

test("admin profile update returns missing before password or upload work", async () => {
  let effects = 0;
  const update = createUpdateAdminSelfProfile(dependencies({
    repository: { async findCredentials() { return null; } },
    avatars: { async upload() { effects += 1; } },
    passwords: { async hash() { effects += 1; } },
  }));
  assert.deepEqual(await update({
    userId: "missing", body: { password: "secret" },
    file: { localPath: "/tmp/a", originalName: "a.png" },
  }), { kind: "not_found" });
  assert.equal(effects, 0);
});

test("admin password change requires and verifies old password before hashing", async () => {
  let hashes = 0;
  const missingOld = createUpdateAdminSelfProfile(dependencies());
  assert.deepEqual(await missingOld({ userId: "a1", body: { password: "newpass" } }), {
    kind: "old_password_required",
  });

  const wrongOld = createUpdateAdminSelfProfile(dependencies({
    passwordVerifier: { async verify(password, hash) {
      assert.equal(password, "wrong");
      assert.equal(hash, "stored");
      return false;
    } },
    passwords: { async hash() { hashes += 1; return "hash"; } },
  }));
  assert.deepEqual(await wrongOld({
    userId: "a1", body: { oldPassword: "wrong", newPassword: "newpass" },
  }), { kind: "wrong_old_password" });
  assert.equal(hashes, 0);
});

test("admin password change rejects short value before verification", async () => {
  let verifies = 0;
  const update = createUpdateAdminSelfProfile(dependencies({
    passwordVerifier: { async verify() { verifies += 1; return true; } },
  }));
  assert.deepEqual(await update({
    userId: "a1", body: { oldPassword: "old", newPassword: "123" },
  }), { kind: "invalid_password" });
  assert.equal(verifies, 0);
});

test("admin profile hashes once and ignores unsupported account fields", async () => {
  let persisted;
  let hashes = 0;
  const update = createUpdateAdminSelfProfile(dependencies({
    repository: {
      async findCredentials() { return { passwordHash: "stored" }; },
      async update(_id, patch) { persisted = patch; return { id: "a1" }; },
    },
    passwordVerifier: { async verify() { return true; } },
    passwords: { async hash(password) { hashes += 1; assert.equal(password, "newpass"); return "one-hash"; } },
  }));
  assert.deepEqual(await update({
    userId: "a1",
    body: {
      oldPassword: "oldpass", newPassword: "newpass", name: " Admin ",
      role: "super_admin", email: "changed@example.com", isBlocked: false,
    },
  }), { kind: "updated", user: { id: "a1" } });
  assert.equal(hashes, 1);
  assert.deepEqual(persisted, { name: "Admin", passwordHash: "one-hash" });
});

test("admin avatar upload uses sanitized owner-scoped object key", async () => {
  let upload;
  let persisted;
  const update = createUpdateAdminSelfProfile(dependencies({
    repository: {
      async findCredentials() { return { passwordHash: "stored" }; },
      async update(_id, patch) { persisted = patch; return { id: "a1", ...patch }; },
    },
    avatars: { async upload(input) { upload = input; return "https://cdn/avatar"; } },
  }));
  const result = await update({
    userId: "a1", body: {},
    file: { localPath: "/tmp/avatar", originalName: "My.PHOTO.JPEG" },
  });
  assert.equal(result.kind, "updated");
  assert.deepEqual(upload, {
    localPath: "/tmp/avatar",
    objectKey: "tenant-assets/admin/a1/avatar-1234.jpeg",
  });
  assert.deepEqual(persisted, { avatar: "https://cdn/avatar" });
});
