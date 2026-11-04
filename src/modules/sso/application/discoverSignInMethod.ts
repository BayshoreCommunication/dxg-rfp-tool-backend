import { emailDomain, isEmail, normalizeEmail } from "../domain/ssoRules";

/* The sign-in page asks for the email first, then shows the right next step: company SSO when
   an active connection covers the email's domain, otherwise the password form. The answer is
   one bit per domain (never the organization), and the route is dashboard-only and limited per
   visitor, so it can't be used to list RFPilot customers at speed. */
export type SignInMethod = "company" | "password";

export const createDiscoverSignInMethod = (deps: { companySsoForDomain(domain: string): Promise<boolean> }) =>
  async (rawEmail: unknown): Promise<{ kind: "validation" } | { kind: "found"; method: SignInMethod }> => {
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) return { kind: "validation" };
    return { kind: "found", method: (await deps.companySsoForDomain(emailDomain(email))) ? "company" : "password" };
  };
