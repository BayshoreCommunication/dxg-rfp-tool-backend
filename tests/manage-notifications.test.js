const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createGetOwnedUnreadCount,
  createListOwnedNotifications,
  createMarkAllOwnedNotificationsRead,
  createMarkOwnedNotificationRead,
} = require("../src/modules/notifications/application/manageNotifications");

test("notification list normalizes paging and preserves owner scope", async () => {
  let repositoryInput;
  const list = createListOwnedNotifications({
    listOwned: async (input) => {
      repositoryInput = input;
      return { notifications: [{ _id: "n-1" }], total: 201, unreadCount: 4 };
    },
  });

  const result = await list({
    ownerUserId: "user-001",
    query: { page: "2", limit: "500", unreadOnly: "true" },
  });

  assert.deepEqual(repositoryInput, {
    ownerUserId: "user-001",
    unreadOnly: true,
    page: 2,
    limit: 100,
  });
  assert.deepEqual(result.pagination, {
    total: 201,
    page: 2,
    limit: 100,
    totalPages: 3,
  });
  assert.equal(result.unreadCount, 4);
});

test("invalid notification paging falls back to safe defaults", async () => {
  let repositoryInput;
  const list = createListOwnedNotifications({
    listOwned: async (input) => {
      repositoryInput = input;
      return { notifications: [], total: 0, unreadCount: 0 };
    },
  });

  await list({
    ownerUserId: "user-001",
    query: { page: "-1", limit: "0", unreadOnly: "yes" },
  });

  assert.equal(repositoryInput.page, 1);
  assert.equal(repositoryInput.limit, 20);
  assert.equal(repositoryInput.unreadOnly, false);
});

test("mark one read carries owner and emits only after successful mutation", async () => {
  const calls = [];
  const now = new Date("2026-07-16T10:00:00.000Z");
  const markRead = createMarkOwnedNotificationRead({
    now: () => now,
    repository: {
      markOwnedRead: async (input) => {
        calls.push({ action: "write", input });
        return { _id: input.notificationId, isRead: true };
      },
    },
    realtime: {
      emitUnreadCount: async (ownerUserId) => {
        calls.push({ action: "emit", ownerUserId });
      },
    },
  });

  const result = await markRead({
    notificationId: "notification-001",
    ownerUserId: "user-001",
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(calls, [
    {
      action: "write",
      input: {
        notificationId: "notification-001",
        ownerUserId: "user-001",
        readAt: now,
      },
    },
    { action: "emit", ownerUserId: "user-001" },
  ]);
});

test("missing or differently owned notification does not emit", async () => {
  let emitted = 0;
  const markRead = createMarkOwnedNotificationRead({
    repository: { markOwnedRead: async () => null },
    realtime: {
      emitUnreadCount: async () => {
        emitted += 1;
      },
    },
  });

  const result = await markRead({
    notificationId: "notification-other-owner",
    ownerUserId: "user-001",
  });

  assert.deepEqual(result, { kind: "not_found" });
  assert.equal(emitted, 0);
});

test("mark-all and unread count remain owner-scoped", async () => {
  const calls = [];
  const now = new Date("2026-07-16T11:00:00.000Z");
  const repository = {
    countUnread: async (ownerUserId) => {
      calls.push({ action: "count", ownerUserId });
      return 6;
    },
    markAllOwnedRead: async (input) => {
      calls.push({ action: "write-all", input });
    },
  };
  const markAll = createMarkAllOwnedNotificationsRead({
    repository,
    now: () => now,
    realtime: {
      emitUnreadCount: async (ownerUserId) => {
        calls.push({ action: "emit", ownerUserId });
      },
    },
  });

  assert.equal(await createGetOwnedUnreadCount(repository)("user-001"), 6);
  await markAll("user-001");

  assert.deepEqual(calls, [
    { action: "count", ownerUserId: "user-001" },
    { action: "write-all", input: { ownerUserId: "user-001", readAt: now } },
    { action: "emit", ownerUserId: "user-001" },
  ]);
});
