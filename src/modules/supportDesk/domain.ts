import {
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
  type SupportTicketCategory,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from "../../../modal/supportTicketModel";
import type { SupportAuthorRole, SupportMessageKind } from "../../../modal/supportMessageModel";

export {
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
};
export type { SupportTicketCategory, SupportTicketPriority, SupportTicketStatus };

export const SUPPORT_SUBJECT_MAX = 200;
export const SUPPORT_BODY_MAX = 5000;
export const SUPPORT_LIST_MAX_PER_PAGE = 50;
export const SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE = 3;
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const;

export class SupportDeskError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type SupportActor = {
  userId: string;
  organizationId: string;
  role: string;
  roles: readonly string[];
};

export type SupportAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
};

export type SupportTicketRecord = {
  id: string;
  ticketNumber: number;
  organizationId: string;
  requesterUserId: string;
  assigneeUserId: string | null;
  subject: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  messageCount: number;
  unreadForRequester: number;
  unreadForAgents: number;
  lastMessageAt: string;
  lastCustomerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  firstAgentResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  responseDueAt: string | null;
  escalatedAt: string | null;
  waitingSince: string | null;
  autoCloseReminderSentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportMessageRecord = {
  id: string;
  ticketId: string;
  authorUserId: string | null;
  authorRole: SupportAuthorRole;
  kind: SupportMessageKind;
  body: string;
  attachments: SupportAttachment[];
  createdAt: string;
};

export type SupportUserSummary = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  role: string;
};

export type SupportTicketPatch = Partial<
  Pick<
    SupportTicketRecord,
    | "assigneeUserId"
    | "priority"
    | "category"
    | "status"
    | "unreadForRequester"
    | "unreadForAgents"
    | "lastMessageAt"
    | "lastCustomerMessageAt"
    | "lastAgentMessageAt"
    | "firstAgentResponseAt"
    | "resolvedAt"
    | "closedAt"
    | "responseDueAt"
    | "escalatedAt"
    | "waitingSince"
    | "autoCloseReminderSentAt"
  >
> & { messageCountDelta?: number };

export type SupportInboxFilters = {
  status?: SupportTicketStatus | "active";
  assignee?: string | "unassigned" | "me";
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  search?: string;
  /** "urgency": tickets owed an answer first, soonest due first. "recent": newest activity first. */
  sort?: "urgency" | "recent";
  page: number;
  perPage: number;
};

export type SupportDeskMetrics = {
  open: number;
  waitingOnCustomer: number;
  resolved: number;
  closed: number;
  unassigned: number;
  unreadForAgents: number;
  /** Open tickets whose response target has passed. */
  overdue: number;
  averageFirstResponseMs: number | null;
  averageResolutionMs: number | null;
  perAgent: Array<{ agentUserId: string; openTickets: number }>;
};

export const isAdministrativeRole = (role?: string): boolean => {
  const normalized = String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};

export const assertAgent = (actor: SupportActor): void => {
  if (!isAdministrativeRole(actor.role)) {
    throw new SupportDeskError("SUPPORT_FORBIDDEN", "Only DXG support agents can do that.", 403);
  }
};

const objectIdPattern = /^[0-9a-f]{24}$/i;

export const parseSupportObjectId = (value: unknown, label = "id"): string => {
  const id = String(value ?? "").trim();
  if (!objectIdPattern.test(id)) {
    throw new SupportDeskError("SUPPORT_INVALID_ID", `A valid ${label} is required.`, 400);
  }
  return id.toLowerCase();
};

const cleanText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();

export const parseSubject = (value: unknown): string => {
  const subject = cleanText(value).replace(/\s+/g, " ");
  if (!subject || subject.length > SUPPORT_SUBJECT_MAX) {
    throw new SupportDeskError(
      "SUPPORT_INVALID_SUBJECT",
      `A subject of 1–${SUPPORT_SUBJECT_MAX} characters is required.`,
      400,
    );
  }
  return subject;
};

export const parseBody = (value: unknown): string => {
  const body = cleanText(value);
  if (!body || body.length > SUPPORT_BODY_MAX) {
    throw new SupportDeskError(
      "SUPPORT_INVALID_BODY",
      `A message of 1–${SUPPORT_BODY_MAX} characters is required.`,
      400,
    );
  }
  return body;
};

const parseEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
  label: string,
): T => {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (!allowed.includes(candidate as T)) {
    throw new SupportDeskError(code, `${label} must be one of: ${allowed.join(", ")}.`, 400);
  }
  return candidate as T;
};

export const parseCategory = (value: unknown): SupportTicketCategory =>
  parseEnum(value, SUPPORT_TICKET_CATEGORIES, "SUPPORT_INVALID_CATEGORY", "Category");
export const parsePriority = (value: unknown): SupportTicketPriority =>
  parseEnum(value, SUPPORT_TICKET_PRIORITIES, "SUPPORT_INVALID_PRIORITY", "Priority");
export const parseStatus = (value: unknown): SupportTicketStatus =>
  parseEnum(value, SUPPORT_TICKET_STATUSES, "SUPPORT_INVALID_STATUS", "Status");

export const parsePage = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? "1"), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
};

export const parsePerPage = (value: unknown, fallback = 20): number => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, SUPPORT_LIST_MAX_PER_PAGE);
};

export const parseSearch = (value: unknown): string | undefined => {
  const search = cleanText(value).replace(/\s+/g, " ").slice(0, 120);
  return search || undefined;
};

const attachmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Clients reference uploads by id only; the server owns every other field. */
export const parseAttachmentIds = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new SupportDeskError("SUPPORT_INVALID_ATTACHMENTS", "Attachments must be a list of upload ids.", 400);
  }
  if (value.length > SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE) {
    throw new SupportDeskError(
      "SUPPORT_TOO_MANY_ATTACHMENTS",
      `At most ${SUPPORT_ATTACHMENTS_MAX_PER_MESSAGE} attachments per message.`,
      400,
    );
  }
  const ids = value.map((item) => String(item ?? "").trim().toLowerCase());
  if (ids.some((id) => !attachmentIdPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new SupportDeskError("SUPPORT_INVALID_ATTACHMENTS", "An attachment id is invalid.", 400);
  }
  return ids;
};

export const isSupportAttachmentId = (value: unknown): value is string =>
  typeof value === "string" && attachmentIdPattern.test(value);

export type SupportUploadCandidate = {
  localPath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

const safeFileName = (value: string): string => {
  const cleaned = cleanText(value).replace(/[\\/]+/g, "_").replace(/\s+/g, " ").slice(0, 255);
  return cleaned || "attachment";
};

/** Validates one multipart file before any scanning or storage happens. */
export const parseUploadCandidate = (value: SupportUploadCandidate): SupportUploadCandidate => {
  const mimeType = String(value.mimeType ?? "").trim().toLowerCase();
  if (!SUPPORT_ATTACHMENT_MIME_TYPES.includes(mimeType as (typeof SUPPORT_ATTACHMENT_MIME_TYPES)[number])) {
    throw new SupportDeskError(
      "SUPPORT_ATTACHMENT_TYPE",
      "Only PNG, JPEG, GIF, WebP images and PDF files can be attached.",
      400,
    );
  }
  if (!Number.isInteger(value.sizeBytes) || value.sizeBytes <= 0 || value.sizeBytes > SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw new SupportDeskError("SUPPORT_ATTACHMENT_SIZE", "Each attachment must be between 1 byte and 10 MB.", 400);
  }
  return { ...value, mimeType, originalName: safeFileName(value.originalName) };
};

const LEGACY_INTERNAL_AUDIT_MARKERS = [
  " assigned this ticket to ",
  " unassigned this ticket.",
  " set priority to ",
  " changed the category to ",
  " renamed the ticket.",
] as const;

export const canBeReadByRequester = (
  message: Pick<SupportMessageRecord, "kind"> & Partial<Pick<SupportMessageRecord, "body">>,
): boolean => {
  if (message.kind === "internal_note") return false;
  if (message.kind !== "system" || !message.body) return true;
  return !LEGACY_INTERNAL_AUDIT_MARKERS.some((marker) => message.body?.includes(marker));
};

export const ticketIsTerminal = (status: SupportTicketStatus): boolean =>
  status === "resolved" || status === "closed";
