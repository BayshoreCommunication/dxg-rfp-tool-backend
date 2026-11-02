import { sendTransactionalEmail } from "../../../../utils/emailService";
import type { InvitationEmail, InvitationMailer } from "../domain/ports";
import { renderInvitationEmail } from "./invitationEmailTemplate";

// Test runs never send email. Integration tests read the links from here.
const recorded: InvitationEmail[] = [];
export const recordingInvitationMailer: InvitationMailer = {
  async send(email) {
    recorded.push(email);
  },
};
export const recordedInvitationEmails = (): readonly InvitationEmail[] => recorded;
export const clearRecordedInvitationEmails = (): void => {
  recorded.length = 0;
};

// The existing mail module (Resend, falling back to SMTP/SES).
export const createTransactionalInvitationMailer = (
  send: typeof sendTransactionalEmail = sendTransactionalEmail,
): InvitationMailer => ({
  async send(email) {
    const rendered = renderInvitationEmail(email);
    await send({ to: email.to, ...rendered });
  },
});

export const defaultInvitationMailer = (): InvitationMailer =>
  process.env.NODE_ENV === "test" ? recordingInvitationMailer : createTransactionalInvitationMailer();
