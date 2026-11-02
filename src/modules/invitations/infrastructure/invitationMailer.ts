import type { InvitationEmail, InvitationMailer } from "../domain/ports";

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

// Email delivery is wired in ORG-204. Until then the attempt is marked failed, which is the truth.
const notConfiguredMailer: InvitationMailer = {
  async send() {
    throw new Error("Invitation email delivery is not configured");
  },
};

export const defaultInvitationMailer = (): InvitationMailer =>
  process.env.NODE_ENV === "test" ? recordingInvitationMailer : notConfiguredMailer;
