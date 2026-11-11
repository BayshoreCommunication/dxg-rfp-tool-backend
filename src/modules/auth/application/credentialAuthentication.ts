import { randomUUID } from "node:crypto";
import type { PasswordHasher, PasswordVerifier } from "../../../shared/security/passwordHasher";
import type {
  AccessTokenIssuer,
  AuthAccountRepository,
  SafeAuthUser,
} from "../domain/ports/authAccountPorts";
import type { SecurityAuditWriter } from "../domain/ports/sessionPorts";

const isAdminRole = (role?: string): boolean => {
  const normalized = String(role ?? "").toLowerCase().trim().replace(/[\s-]/g, "_");
  return normalized === "admin" || normalized === "super_admin" || normalized === "superadmin";
};

type LoginResult =
  | { kind: "validation" }
  | { kind: "not_found" }
  | { kind: "wrong_password" }
  | { kind: "not_admin" }
  | { kind: "blocked" }
  | { kind: "authenticated"; user: SafeAuthUser; token: ReturnType<AccessTokenIssuer["issue"]> };

export const createAuthenticateCredentials = (dependencies: {
  accounts: AuthAccountRepository;
  passwords: PasswordVerifier;
  tokens: AccessTokenIssuer;
  // ORG-407: failed sign-ins on a known account are audited in that account's organization.
  audit?: SecurityAuditWriter;
}) => async (
  input: { email?: unknown; password?: unknown },
  mode: "customer" | "admin",
  context: { correlationId?: string } = {},
): Promise<LoginResult> => {
  const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !password) return { kind: "validation" };
  const credentials = await dependencies.accounts.findCredentials(email);
  if (!credentials) return { kind: "not_found" };
  // An unknown email has no organization to record against, so only known accounts are audited.
  // The event never carries the email or the password, and a failed write never changes the answer.
  const loginFailed = async (reason: "wrong_password" | "account_blocked") => {
    const { id, organizationId } = credentials.user;
    if (!dependencies.audit || !organizationId) return;
    try {
      await dependencies.audit.append({
        organizationId,
        actorUserId: id,
        action: "auth.login.failed",
        targetType: "user",
        targetId: id,
        decision: "denied",
        reason,
        correlationId: context.correlationId || randomUUID(),
        metadata: { method: "password" },
      });
    } catch (error) {
      console.error("Login failure audit error:", error instanceof Error ? error.message : error);
    }
  };
  if (!await dependencies.passwords.verify(password, credentials.passwordHash)) {
    await loginFailed("wrong_password");
    return { kind: "wrong_password" };
  }
  if (mode === "admin" && !isAdminRole(credentials.user.role)) return { kind: "not_admin" };
  if (credentials.isBlocked) {
    await loginFailed("account_blocked");
    return { kind: "blocked" };
  }
  const role = mode === "customer" ? "customer" : credentials.user.role || "admin";
  return {
    kind: "authenticated",
    user: credentials.user,
    token: dependencies.tokens.issue({
      userId: credentials.user.id,
      email: credentials.user.email,
      role,
      ...(credentials.user.organizationId ? { organizationId: credentials.user.organizationId } : {}),
    }),
  };
};

type AdminSignupResult =
  | { kind: "validation" }
  | { kind: "invalid_password" }
  | { kind: "invalid_secret" }
  | { kind: "email_conflict" }
  | { kind: "created"; user: SafeAuthUser; token: ReturnType<AccessTokenIssuer["issue"]> };

export const createRegisterAdmin = (dependencies: {
  accounts: AuthAccountRepository;
  passwords: PasswordHasher;
  tokens: AccessTokenIssuer;
}) => async (
  input: {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    password?: unknown;
    adminSecret?: unknown;
  },
  configuredSecret?: string,
): Promise<AdminSignupResult> => {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!name || !email || !password) return { kind: "validation" };
  if (password.length < 6) return { kind: "invalid_password" };
  // Fails closed: an unset or blank ADMIN_SIGNUP_SECRET refuses outright. This
  // previously read `if (configuredSecret && ...)`, so an unconfigured secret
  // silently disabled the check and left admin account creation open to anyone
  // who could reach the endpoint — and the variable was absent from
  // .env.example, so unset was the documented setup.
  if (
    !configuredSecret?.trim() ||
    String(input.adminSecret ?? "").trim() !== configuredSecret.trim()
  ) {
    return { kind: "invalid_secret" };
  }
  if (await dependencies.accounts.emailExists(email)) return { kind: "email_conflict" };
  const user = await dependencies.accounts.createAdmin({
    name,
    email,
    phone: typeof input.phone === "string" && input.phone ? input.phone.trim() : undefined,
    passwordHash: await dependencies.passwords.hash(password),
  });
  return {
    kind: "created",
    user,
    token: dependencies.tokens.issue({ userId: user.id, email: user.email, role: "admin", ...(user.organizationId ? { organizationId: user.organizationId } : {}) }),
  };
};

export const createGetAuthenticatedUser = (accounts: AuthAccountRepository) =>
  (userId: string) => accounts.findSafeById(userId);
