type Attachment = { sourceStatus?: string | null };

// File metadata is not extracted content. Acknowledge receipt without asking
// the planner to repeat their brief or claiming an extraction has succeeded.
export const attachmentReceiptReply = (attachments: Attachment[]): string | null => {
  if (!attachments.length) return null;
  if (attachments.some(item => item.sourceStatus === "blocked"))
    return "Your attachment did not pass the file security checks, so I can’t read it. Please choose another file, or continue by entering the event details yourself.";
  if (attachments.some(item => ["failed", "scan_failed"].includes(item.sourceStatus ?? "")))
    return "I received your attachment, but its file check hasn’t completed successfully. I haven’t read its contents yet. Use the file recovery options below before we continue.";
  return "I’ve received your brief. I’ll check the file and pull out the event details, then we’ll review what I found and work through anything missing together.";
};
