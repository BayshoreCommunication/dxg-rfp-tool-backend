import { OAuth2Client } from "google-auth-library";
import type { GoogleIdentityVerifier } from "../../domain/ports/googleIdentityPorts";

const client = new OAuth2Client();

export const googleIdTokenVerifier: GoogleIdentityVerifier = {
  async verify(idToken) {
    const audience = String(process.env.GOOGLE_CLIENT_ID ?? "").trim();
    if (!audience) throw new Error("GOOGLE_CLIENT_ID is required for Google authentication");
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new Error("Google identity is missing a verified email");
    }
    return {
      subject: payload.sub,
      email: payload.email.toLowerCase().trim(),
      name: payload.name?.trim() || undefined,
      avatar: payload.picture?.trim() || undefined,
    };
  },
};
