import crypto from "node:crypto";
import {
  SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE,
  SupportDeskError,
  assertAgent,
  canBeReadByRequester,
  isSupportAttachmentId,
  parseSupportObjectId,
  parseUploadCandidate,
  type SupportActor,
  type SupportAttachment,
  type SupportUploadCandidate,
} from "../domain";
import type {
  SupportAttachmentStorage,
  SupportDeskClock,
  SupportDeskRepository,
  SupportUploadScanner,
} from "../domain/ports/supportDeskPorts";

export const SUPPORT_ATTACHMENT_DOWNLOAD_SECONDS = 300;

export type SupportAttachmentDependencies = {
  repository: SupportDeskRepository;
  storage: SupportAttachmentStorage;
  scanner: SupportUploadScanner;
  clock?: SupportDeskClock;
};

const objectKeyFor = (organizationId: string, attachmentId: string, fileName: string): string => {
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : "";
  return `support-attachments/${organizationId}/${attachmentId}${safeExtension}`;
};

/**
 * Upload intake shared by planners and agents. Every file is validated,
 * scanned, and stored privately before a pending record exists; nothing is
 * attached to a ticket until the uploader sends the message that cites it.
 */
export const createSupportAttachments = (dependencies: SupportAttachmentDependencies) => {
  const { repository, storage, scanner } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());

  const register = async (
    actor: SupportActor,
    files: readonly SupportUploadCandidate[],
  ): Promise<SupportAttachment[]> => {
    if (files.length === 0) {
      throw new SupportDeskError("SUPPORT_ATTACHMENT_MISSING", "Choose at least one file to upload.", 400);
    }
    if (files.length > SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE) {
      throw new SupportDeskError(
        "SUPPORT_TOO_MANY_ATTACHMENTS",
        `At most ${SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE} attachments per message.`,
        400,
      );
    }
    const candidates = files.map(parseUploadCandidate);
    const stored: SupportAttachment[] = [];
    for (const candidate of candidates) {
      const outcome = await scanner.scan(candidate.localPath);
      if (outcome === "infected") {
        throw new SupportDeskError(
          "SUPPORT_ATTACHMENT_INFECTED",
          `"${candidate.originalName}" was rejected by the malware scanner.`,
          422,
        );
      }
      if (outcome === "unavailable") {
        throw new SupportDeskError(
          "SUPPORT_SCAN_UNAVAILABLE",
          "Attachments cannot be scanned right now. Try again in a few minutes.",
          503,
        );
      }
      const attachmentId = crypto.randomUUID();
      const attachment: SupportAttachment = {
        id: attachmentId,
        fileName: candidate.originalName,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.sizeBytes,
        objectKey: objectKeyFor(actor.organizationId, attachmentId, candidate.originalName),
      };
      await storage.upload({
        localPath: candidate.localPath,
        objectKey: attachment.objectKey,
        mimeType: attachment.mimeType,
      });
      await repository.createPendingAttachment({
        organizationId: actor.organizationId,
        uploaderUserId: actor.userId,
        attachment,
        now: clock(),
      });
      stored.push(attachment);
    }
    return stored;
  };

  const presign = async (
    actor: SupportActor,
    ticketId: unknown,
    attachmentId: unknown,
    options: { customer: boolean },
  ): Promise<{ url: string; attachment: SupportAttachment }> => {
    const id = parseSupportObjectId(ticketId, "ticket id");
    if (!isSupportAttachmentId(attachmentId)) {
      throw new SupportDeskError("SUPPORT_ATTACHMENT_NOT_FOUND", "The attachment was not found.", 404);
    }
    const ticket = await repository.findTicket(actor.organizationId, id);
    if (!ticket || (options.customer && ticket.requesterUserId !== actor.userId)) {
      throw new SupportDeskError("SUPPORT_TICKET_NOT_FOUND", "The support ticket was not found.", 404);
    }
    const found = await repository.findTicketAttachment(actor.organizationId, id, attachmentId.toLowerCase());
    if (!found || (options.customer && !canBeReadByRequester({ kind: found.messageKind }))) {
      throw new SupportDeskError("SUPPORT_ATTACHMENT_NOT_FOUND", "The attachment was not found.", 404);
    }
    const url = await storage.presignDownload(found.attachment.objectKey, SUPPORT_ATTACHMENT_DOWNLOAD_SECONDS);
    return { url, attachment: found.attachment };
  };

  return {
    async uploadForCustomer(actor: SupportActor, files: readonly SupportUploadCandidate[]) {
      return register(actor, files);
    },
    async uploadForAgent(actor: SupportActor, files: readonly SupportUploadCandidate[]) {
      assertAgent(actor);
      return register(actor, files);
    },
    async customerDownload(actor: SupportActor, ticketId: unknown, attachmentId: unknown) {
      return presign(actor, ticketId, attachmentId, { customer: true });
    },
    async agentDownload(actor: SupportActor, ticketId: unknown, attachmentId: unknown) {
      assertAgent(actor);
      return presign(actor, ticketId, attachmentId, { customer: false });
    },
  };
};

export type SupportAttachments = ReturnType<typeof createSupportAttachments>;

/**
 * Resolves the upload ids a message cites into attachment metadata, refusing
 * anything the uploader does not own or has already used.
 */
export const claimAttachmentsForMessage = async (
  repository: SupportDeskRepository,
  actor: SupportActor,
  ids: readonly string[],
): Promise<SupportAttachment[]> => {
  if (ids.length === 0) return [];
  const claimed = await repository.claimPendingAttachments({
    organizationId: actor.organizationId,
    uploaderUserId: actor.userId,
    ids,
  });
  if (!claimed) {
    throw new SupportDeskError(
      "SUPPORT_INVALID_ATTACHMENTS",
      "One of the attachments is missing, already used, or not yours. Upload it again.",
      400,
    );
  }
  return claimed;
};
