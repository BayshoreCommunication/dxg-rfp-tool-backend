import type { PasswordHasher } from "../../../shared/security/passwordHasher";
import type { AccessTokenIssuer } from "../domain/ports/authAccountPorts";
import type {
  GoogleAccountRepository,
  GoogleIdentityVerifier,
  RandomSecretGenerator,
} from "../domain/ports/googleIdentityPorts";

type GoogleAuthenticationResult =
  | { kind: "validation" }
  | { kind: "invalid_identity" }
  | { kind: "blocked" }
  | { kind: "sso_required" }
  // ORG-306: a new account on another organization's verified domain chooses first.
  | { kind: "domain_match"; organizationName: string }
  | {
      kind: "authenticated";
      user: Awaited<ReturnType<GoogleAccountRepository["createGoogleAccount"]>>;
      isNewUser: boolean;
      token: ReturnType<AccessTokenIssuer["issue"]>;
    };

export const createAuthenticateGoogleIdentity = (dependencies: {
  verifier: GoogleIdentityVerifier;
  accounts: GoogleAccountRepository;
  secrets: RandomSecretGenerator;
  passwords: PasswordHasher;
  tokens: AccessTokenIssuer;
  /** Require SSO: the email's organization makes its members use the company sign-in. */
  ssoRequiredFor?: (email: string) => Promise<boolean>;
  /** ORG-306: the organization that verified the email's domain, if any. */
  domainOrganizationFor?: (email: string) => Promise<{ name: string } | null>;
}) => async (idToken: unknown, options: { separateOrganization?: boolean } = {}): Promise<GoogleAuthenticationResult> => {
  if (typeof idToken !== "string" || !idToken.trim()) return { kind: "validation" };
  let identity;
  try {
    identity = await dependencies.verifier.verify(idToken.trim());
  } catch {
    return { kind: "invalid_identity" };
  }
  // Before any account is linked or created, so a blocked sign-in leaves nothing behind.
  if (await dependencies.ssoRequiredFor?.(identity.email.toLowerCase().trim())) return { kind: "sso_required" };
  const existing = await dependencies.accounts.findAndLinkExisting(identity);
  if (existing?.isBlocked) return { kind: "blocked" };
  // Before creating anything: offer "Request access" unless they chose a separate organization.
  if (!existing && !options.separateOrganization) {
    const match = await dependencies.domainOrganizationFor?.(identity.email.toLowerCase().trim());
    if (match) return { kind: "domain_match", organizationName: match.name };
  }
  const user = existing?.user ?? await dependencies.accounts.createGoogleAccount({
    identity,
    fallbackPasswordHash: await dependencies.passwords.hash(dependencies.secrets.generate()),
  });
  return {
    kind: "authenticated",
    user,
    isNewUser: !existing,
    token: dependencies.tokens.issue({
      userId: user.id,
      email: user.email,
      role: user.role || "customer",
      ...(user.organizationId ? { organizationId: user.organizationId } : {}),
    }),
  };
};
