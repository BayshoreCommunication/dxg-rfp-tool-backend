import type {
  SupportAttachment,
  SupportDeskMetrics,
  SupportInboxFilters,
  SupportMessageRecord,
  SupportTicketCategory,
  SupportTicketPatch,
  SupportTicketPriority,
  SupportTicketRecord,
  SupportTicketStatus,
  SupportUserSummary,
} from "../../domain";
import type { SupportAuthorRole, SupportMessageKind } from "../../../../../modal/supportMessageModel";

export interface SupportDeskRepository {
  createTicket(input: {
    organizationId: string;
    requesterUserId: string;
    subject: string;
    category: SupportTicketCategory;
    priority: SupportTicketPriority;
    now: Date;
  }): Promise<SupportTicketRecord>;
  findTicket(organizationId: string, ticketId: string): Promise<SupportTicketRecord | null>;
  listTickets(
    organizationId: string,
    filters: SupportInboxFilters & { requesterUserId?: string; assigneeUserId?: string },
  ): Promise<{ tickets: SupportTicketRecord[]; total: number }>;
  updateTicket(
    organizationId: string,
    ticketId: string,
    patch: SupportTicketPatch,
  ): Promise<SupportTicketRecord | null>;
  countRequesterUnread(organizationId: string, requesterUserId: string): Promise<number>;
  appendMessage(input: {
    organizationId: string;
    ticketId: string;
    authorUserId: string | null;
    authorRole: SupportAuthorRole;
    kind: SupportMessageKind;
    body: string;
    attachments: SupportAttachment[];
    now: Date;
  }): Promise<SupportMessageRecord>;
  listMessages(
    organizationId: string,
    ticketId: string,
    options: { includeInternal: boolean },
  ): Promise<SupportMessageRecord[]>;
  metrics(organizationId: string, now: Date): Promise<SupportDeskMetrics>;
  listAgents(organizationId: string): Promise<SupportUserSummary[]>;
  /** Active (open or waiting) tickets per assignee, for automatic assignment. */
  agentLoads(organizationId: string): Promise<Map<string, number>>;
  /** Open tickets, across organizations, still unanswered at `answeredBefore`. */
  listUnansweredSince(answeredBefore: Date, limit: number): Promise<SupportTicketRecord[]>;
  /** Waiting tickets, across organizations, idle since `waitingBefore` with no reminder yet. */
  listNeedingCloseReminder(waitingBefore: Date, limit: number): Promise<SupportTicketRecord[]>;
  /** Reminded tickets, across organizations, idle since `waitingBefore` and reminded before `remindedBefore`. */
  listDueToAutoResolve(waitingBefore: Date, remindedBefore: Date, limit: number): Promise<SupportTicketRecord[]>;
  /** Resolved tickets, across organizations, resolved at or before `resolvedBefore`. */
  listResolvedBefore(resolvedBefore: Date, limit: number): Promise<SupportTicketRecord[]>;
  /** One-time fill of the service-level fields on tickets created before they existed. */
  backfillServiceLevels(now: Date): Promise<number>;
  findUserSummaries(
    organizationId: string,
    userIds: readonly string[],
  ): Promise<Map<string, SupportUserSummary>>;
  listCannedReplies(organizationId: string): Promise<SupportCannedReplyRecord[]>;
  createCannedReply(input: {
    organizationId: string;
    title: string;
    body: string;
    createdByUserId: string;
  }): Promise<SupportCannedReplyRecord>;
  updateCannedReply(
    organizationId: string,
    id: string,
    patch: { title?: string; body?: string },
  ): Promise<SupportCannedReplyRecord | null>;
  deleteCannedReply(organizationId: string, id: string): Promise<boolean>;
  createPendingAttachment(input: {
    organizationId: string;
    uploaderUserId: string;
    attachment: SupportAttachment;
    now: Date;
  }): Promise<void>;
  /**
   * Returns the uploader's pending uploads for the given ids, in the given
   * order, or null when any id is unknown, already used, or someone else's.
   */
  claimPendingAttachments(input: {
    organizationId: string;
    uploaderUserId: string;
    ids: readonly string[];
  }): Promise<SupportAttachment[] | null>;
  markAttachmentsUsed(input: {
    organizationId: string;
    ids: readonly string[];
    ticketId: string;
    messageId: string;
  }): Promise<void>;
  findTicketAttachment(
    organizationId: string,
    ticketId: string,
    attachmentId: string,
  ): Promise<{ attachment: SupportAttachment; messageKind: SupportMessageKind } | null>;
}

export interface SupportAttachmentStorage {
  upload(input: { localPath: string; objectKey: string; mimeType: string }): Promise<void>;
  presignDownload(objectKey: string, expiresSeconds: number): Promise<string>;
}

export type SupportUploadScanOutcome = "clean" | "infected" | "skipped" | "unavailable";

export interface SupportUploadScanner {
  scan(localPath: string): Promise<SupportUploadScanOutcome>;
}

export type SupportCannedReplyRecord = {
  id: string;
  title: string;
  body: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export interface SupportDeskNotifier {
  ticketCreated(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
    message: SupportMessageRecord;
  }): Promise<void>;
  customerReplied(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
    message: SupportMessageRecord;
  }): Promise<void>;
  agentReplied(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
    agent: SupportUserSummary | null;
    message: SupportMessageRecord;
  }): Promise<void>;
  statusChanged(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
    status: SupportTicketStatus;
    byAgent: boolean;
  }): Promise<void>;
  /** A ticket was given to an agent by someone else or automatically. */
  ticketAssigned(input: {
    ticket: SupportTicketRecord;
    assigneeUserId: string;
    assignedBy: string | null;
  }): Promise<void>;
  /** The owner has not answered in time: every agent is alerted. */
  ticketEscalated(input: {
    ticket: SupportTicketRecord;
    assignee: SupportUserSummary | null;
    waitingMinutes: number;
  }): Promise<void>;
  autoCloseReminder(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
    message: SupportMessageRecord;
  }): Promise<void>;
  /** The customer went quiet, so the ticket was resolved for them. */
  autoResolved(input: {
    ticket: SupportTicketRecord;
    requester: SupportUserSummary | null;
  }): Promise<void>;
}

export type SupportDeskClock = () => Date;

export type SupportPresenceState = "viewing" | "replying";
export type SupportPresenceEntry = { userId: string; state: SupportPresenceState; at: string };

/** Short-lived "who has this ticket open" entries; anything not refreshed fades out. */
export interface SupportPresenceStore {
  touch(organizationId: string, ticketId: string, entry: SupportPresenceEntry): Promise<void>;
  list(organizationId: string, ticketId: string): Promise<SupportPresenceEntry[]>;
  remove(organizationId: string, ticketId: string, userId: string): Promise<void>;
}
