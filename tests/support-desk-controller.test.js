require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSupportDeskController } = require("../controller/supportDeskController");
const { SupportDeskError } = require("../src/modules/supportDesk/domain");

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.jsonBody = undefined;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.jsonBody = body;
    return this;
  }
}

const request = (overrides = {}) => ({
  user: {
    userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    organizationId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    role: "customer",
    roles: ["planner"],
  },
  params: {},
  query: {},
  body: {},
  ...overrides,
});

test("controller maps the actor, body, and query into the services", async () => {
  let captured;
  const controller = createSupportDeskController({
    customer: {
      async createTicket(actor, input) {
        captured = { actor, input };
        return { ticket: { id: "t" }, message: { id: "m" } };
      },
      async listOwnTickets(actor, query) {
        captured = { actor, query };
        return { tickets: [], pagination: {} };
      },
    },
    agent: {
      async updateTicket(actor, ticketId, input) {
        captured = { actor, ticketId, input };
        return { id: ticketId };
      },
    },
  });

  const created = new MockResponse();
  await controller.createTicket(request({ body: { subject: "s", body: "b" } }), created);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.jsonBody, { success: true, data: { ticket: { id: "t" }, message: { id: "m" } } });
  assert.deepEqual(captured.actor, {
    userId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    organizationId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    role: "customer",
    roles: ["planner"],
  });
  assert.deepEqual(captured.input, { subject: "s", body: "b" });

  const listed = new MockResponse();
  await controller.listOwnTickets(request({ query: { status: "active", page: "2" } }), listed);
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(captured.query, { status: "active", page: "2" });

  const patched = new MockResponse();
  await controller.updateTicket(
    request({ params: { ticketId: "t1" }, body: { priority: "high" }, user: { userId: "c", organizationId: "a", role: "admin" } }),
    patched,
  );
  assert.deepEqual(captured, { actor: { userId: "c", organizationId: "a", role: "admin", roles: [] }, ticketId: "t1", input: { priority: "high" } });
});

test("controller returns problem JSON for domain errors and hides internal failures", async () => {
  const controller = createSupportDeskController({
    customer: {
      async getOwnTicket() {
        throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
      },
      async replyToOwnTicket() {
        throw new Error("mongo exploded with secrets");
      },
    },
    agent: {},
  });

  const missing = new MockResponse();
  await controller.getOwnTicket(request({ params: { ticketId: "x" } }), missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.jsonBody, {
    success: false,
    code: "SUPPORT_TICKET_NOT_FOUND",
    message: "The support ticket was not found.",
  });

  const original = console.error;
  console.error = () => {};
  try {
    const broken = new MockResponse();
    await controller.replyToOwnTicket(request({ params: { ticketId: "x" } }), broken);
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.jsonBody.code, "SUPPORT_INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(broken.jsonBody), /secrets/);
  } finally {
    console.error = original;
  }

  const anonymous = new MockResponse();
  await controller.listOwnTickets({ params: {}, query: {}, body: {} }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.jsonBody.code, "AUTHENTICATION_REQUIRED");
});

test("upload intake always discards temp files and maps intake errors", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-upload-"));
  const tempPath = path.join(dir, "a.png");
  fs.writeFileSync(tempPath, "png");
  const controller = createSupportDeskController({
    customer: {},
    agent: {},
    attachments: {
      async uploadForCustomer(actor, files) {
        assert.deepEqual(files, [{ localPath: tempPath, originalName: "a.png", mimeType: "image/png", sizeBytes: 3 }]);
        return [{ id: "11111111-1111-4111-8111-111111111111", fileName: "a.png", mimeType: "image/png", sizeBytes: 3, objectKey: "k" }];
      },
    },
  });
  const res = new MockResponse();
  await controller.uploadOwnAttachments(
    request({ files: [{ path: tempPath, originalname: "a.png", mimetype: "image/png", size: 3 }] }),
    res,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.jsonBody.data.attachments[0].fileName, "a.png");
  assert.equal(fs.existsSync(tempPath), false);

  fs.writeFileSync(tempPath, "png");
  const failing = createSupportDeskController({
    customer: {},
    agent: {},
    attachments: {
      async uploadForCustomer() {
        throw new SupportDeskError("SUPPORT_ATTACHMENT_INFECTED", "rejected", 422);
      },
    },
  });
  const rejected = new MockResponse();
  await failing.uploadOwnAttachments(
    request({ files: [{ path: tempPath, originalname: "a.png", mimetype: "image/png", size: 3 }] }),
    rejected,
  );
  assert.equal(rejected.statusCode, 422);
  assert.equal(fs.existsSync(tempPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("routes guard the agent inbox with administrative roles and rate-limit customer writes", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../routes/supportDeskRoute.ts"), "utf8");
  for (const route of [
    '"/support/tickets"',
    '"/support/tickets/unread-count"',
    '"/support/tickets/:ticketId/messages"',
    '"/support/tickets/:ticketId/resolve"',
    '"/admin/support/tickets"',
    '"/admin/support/metrics"',
    '"/admin/support/agents"',
    '"/admin/support/canned-replies"',
    '"/admin/support/tickets/:ticketId/notes"',
    '"/support/attachments"',
    '"/support/tickets/:ticketId/attachments/:attachmentId"',
    '"/admin/support/attachments"',
    '"/admin/support/tickets/:ticketId/attachments/:attachmentId"',
  ]) {
    assert.ok(source.includes(route), route);
  }
  assert.match(source, /authorize\("admin", "super_admin", "superadmin"\)/);
  assert.match(source, /customerWriteLimit, controller\.createTicket/);
  assert.match(source, /customerWriteLimit, controller\.replyToOwnTicket/);
  assert.match(source, /customerWriteLimit, receiveSupportAttachments, controller\.uploadOwnAttachments/);
  assert.match(source, /\.\.\.agentGuard, receiveSupportAttachments, controller\.uploadAgentAttachments/);
  const adminLines = source.split("\n").filter((line) => line.includes('"/admin/support/'));
  assert.ok(adminLines.length >= 11);
  assert.ok(adminLines.every((line) => line.includes("...agentGuard")), "every admin route uses the agent guard");
  const server = fs.readFileSync(path.resolve(__dirname, "../server.ts"), "utf8");
  assert.match(server, /app\.use\("\/api\/v1", supportDeskRoutes\)/);
});
