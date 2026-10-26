import mongoose, { Document, Schema } from "mongoose";

export const SUPPORT_TICKET_STATUSES = [
  "open",
  "waiting_on_customer",
  "resolved",
  "closed",
] as const;
export const SUPPORT_TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const SUPPORT_TICKET_CATEGORIES = [
  "how_to",
  "bug",
  "billing",
  "vendor_email",
  "other",
] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];

export interface ISupportTicket extends Document {
  organizationId: mongoose.Types.ObjectId;
  ticketNumber: number;
  requesterUserId: mongoose.Types.ObjectId;
  assigneeUserId: mongoose.Types.ObjectId | null;
  subject: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  messageCount: number;
  unreadForRequester: number;
  unreadForAgents: number;
  lastMessageAt: Date;
  lastCustomerMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
  firstAgentResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  /** When the latest customer message needs an agent answer by (null when nothing is owed). */
  responseDueAt: Date | null;
  /** When every agent was alerted because the owner had not answered in time. */
  escalatedAt: Date | null;
  /** When the ticket started waiting on the customer (drives auto-close). */
  waitingSince: Date | null;
  autoCloseReminderSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    ticketNumber: { type: Number, required: true },
    requesterUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assigneeUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: SUPPORT_TICKET_CATEGORIES, required: true, default: "other" },
    priority: { type: String, enum: SUPPORT_TICKET_PRIORITIES, required: true, default: "normal" },
    status: { type: String, enum: SUPPORT_TICKET_STATUSES, required: true, default: "open" },
    messageCount: { type: Number, default: 0 },
    unreadForRequester: { type: Number, default: 0 },
    unreadForAgents: { type: Number, default: 0 },
    lastMessageAt: { type: Date, required: true },
    lastCustomerMessageAt: { type: Date, default: null },
    lastAgentMessageAt: { type: Date, default: null },
    firstAgentResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    responseDueAt: { type: Date, default: null },
    escalatedAt: { type: Date, default: null },
    waitingSince: { type: Date, default: null },
    autoCloseReminderSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

supportTicketSchema.index({ organizationId: 1, ticketNumber: 1 }, { unique: true });
supportTicketSchema.index({ organizationId: 1, status: 1, lastMessageAt: -1 });
supportTicketSchema.index({ organizationId: 1, requesterUserId: 1, lastMessageAt: -1 });
supportTicketSchema.index({ organizationId: 1, assigneeUserId: 1, status: 1 });
// The sweeper's escalation and auto-close scans.
supportTicketSchema.index({ status: 1, responseDueAt: 1 });
supportTicketSchema.index({ status: 1, waitingSince: 1 });

const SupportTicket = mongoose.model<ISupportTicket>("SupportTicket", supportTicketSchema);

export default SupportTicket;

export interface ISupportTicketCounter extends Document {
  organizationId: mongoose.Types.ObjectId;
  seq: number;
}

const supportTicketCounterSchema = new Schema<ISupportTicketCounter>({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

export const SupportTicketCounter = mongoose.model<ISupportTicketCounter>(
  "SupportTicketCounter",
  supportTicketCounterSchema,
);
