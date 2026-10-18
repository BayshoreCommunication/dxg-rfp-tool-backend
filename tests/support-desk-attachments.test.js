require("ts-node/register/transpile-only");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSupportAttachments,
  SUPPORT_ATTACHMENT_DOWNLOAD_SECONDS,
} = require("../src/modules/supportDesk/application/supportAttachments");
const { SupportDeskError } = require("../src/modules/supportDesk/domain");

const ORG = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PLANNER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbc";
const AGENT = "cccccccccccccccccccccccc";
const TICKET = "0000000000000000000003e9";
const planner = { userId: PLANNER, organizationId: ORG, role: "customer", roles: ["planner"] };
const other = { ...planner, userId: OTHER };
const agent = { userId: AGENT, organizationId: ORG, role: "admin", roles: ["organization_admin"] };

const build = (scanOutcome = "clean") => {
  const pending = [];
  const stored = [];
  let presigned = [];
  const attachmentsOnMessages = new Map();
  const repository = {
    async createPendingAttachment(input) { pending.push(input); },
    async findTicket(organizationId, ticketId) {
      return ticketId === TICKET ? { id: TICKET, organizationId, requesterUserId: PLANNER } : null;
    },
    async findTicketAttachment(organizationId, ticketId, attachmentId) {
      return attachmentsOnMessages.get(attachmentId) ?? null;
    },
  };
  const storage = {
    async upload(input) { stored.push(input); },
    async presignDownload(objectKey, seconds) { presigned.push([objectKey, seconds]); return `https://signed.example/${objectKey}`; },
  };
  const scanner = { async scan() { return scanOutcome; } };
  return {
    pending, stored, presigned, attachmentsOnMessages,
    service: createSupportAttachments({ repository, storage, scanner, clock: () => new Date("2026-10-18T00:00:00Z") }),
  };
};

const file = (overrides = {}) => ({
  localPath: "/tmp/upload-1",
  originalName: "screen shot.PNG",
  mimeType: "image/png",
  sizeBytes: 2048,
  ...overrides,
});

const rejects = async (work, code, status) => {
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof SupportDeskError, String(error));
    assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
};

test("uploads are validated, scanned, stored privately, and recorded as pending", async () => {
  const { service, pending, stored } = build();
  const [attachment] = await service.uploadForCustomer(planner, [file()]);
  assert.match(attachment.id, /^[0-9a-f-]{36}$/);
  assert.equal(attachment.fileName, "screen shot.PNG");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.sizeBytes, 2048);
  assert.equal(attachment.objectKey, `support-attachments/${ORG}/${attachment.id}.png`);
  assert.deepEqual(stored, [{ localPath: "/tmp/upload-1", objectKey: attachment.objectKey, mimeType: "image/png" }]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].uploaderUserId, PLANNER);
  assert.equal(pending[0].organizationId, ORG);
});

test("type, size, count, and scanner outcomes fail closed before storage", async () => {
  const clean = build();
  await rejects(() => clean.service.uploadForCustomer(planner, []), "SUPPORT_ATTACHMENT_MISSING", 400);
  await rejects(() => clean.service.uploadForCustomer(planner, [file(), file(), file(), file()]), "SUPPORT_TOO_MANY_ATTACHMENTS", 400);
  await rejects(() => clean.service.uploadForCustomer(planner, [file({ mimeType: "application/x-msdownload", originalName: "x.exe" })]), "SUPPORT_ATTACHMENT_TYPE", 400);
  await rejects(() => clean.service.uploadForCustomer(planner, [file({ sizeBytes: 11 * 1024 * 1024 })]), "SUPPORT_ATTACHMENT_SIZE", 400);
  assert.equal(clean.stored.length, 0);

  const infected = build("infected");
  await rejects(() => infected.service.uploadForCustomer(planner, [file()]), "SUPPORT_ATTACHMENT_INFECTED", 422);
  assert.equal(infected.stored.length, 0);

  const unavailable = build("unavailable");
  await rejects(() => unavailable.service.uploadForCustomer(planner, [file()]), "SUPPORT_SCAN_UNAVAILABLE", 503);

  const skipped = build("skipped");
  assert.equal((await skipped.service.uploadForCustomer(planner, [file()])).length, 1);

  await rejects(() => clean.service.uploadForAgent(planner, [file()]), "SUPPORT_FORBIDDEN", 403);
  assert.equal((await clean.service.uploadForAgent(agent, [file()])).length, 1);
});

test("downloads are presigned only for authorized tickets and visible messages", async () => {
  const { service, attachmentsOnMessages, presigned } = build();
  const visible = { id: "22222222-2222-4222-8222-222222222222", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, objectKey: "k/visible" };
  const secret = { id: "33333333-3333-4333-8333-333333333333", fileName: "n.png", mimeType: "image/png", sizeBytes: 10, objectKey: "k/secret" };
  attachmentsOnMessages.set(visible.id, { attachment: visible, messageKind: "message" });
  attachmentsOnMessages.set(secret.id, { attachment: secret, messageKind: "internal_note" });

  const own = await service.customerDownload(planner, TICKET, visible.id);
  assert.equal(own.url, "https://signed.example/k/visible");
  assert.deepEqual(presigned.at(-1), ["k/visible", SUPPORT_ATTACHMENT_DOWNLOAD_SECONDS]);

  await rejects(() => service.customerDownload(other, TICKET, visible.id), "SUPPORT_TICKET_NOT_FOUND", 404);
  await rejects(() => service.customerDownload(planner, TICKET, secret.id), "SUPPORT_ATTACHMENT_NOT_FOUND", 404);
  await rejects(() => service.customerDownload(planner, TICKET, "not-a-uuid"), "SUPPORT_ATTACHMENT_NOT_FOUND", 404);
  await rejects(() => service.customerDownload(planner, "0000000000000000000003ea", visible.id), "SUPPORT_TICKET_NOT_FOUND", 404);

  const agentSecret = await service.agentDownload(agent, TICKET, secret.id);
  assert.equal(agentSecret.attachment.fileName, "n.png");
  await rejects(() => service.agentDownload(planner, TICKET, secret.id), "SUPPORT_FORBIDDEN", 403);
});
