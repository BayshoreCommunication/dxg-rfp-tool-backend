import type { PasswordHasher } from "../../../shared/security/passwordHasher";
import type {
  AccessTokenIssuer,
  AuthAccountRepository,
} from "../domain/ports/authAccountPorts";
import type { OtpRepository } from "../domain/ports/otpPorts";

type RegisterResult =
  | { kind: "validation" }
  | { kind: "invalid_password" }
  | { kind: "unverified" }
  | { kind: "email_conflict" }
  | {
      kind: "created";
      user: Awaited<ReturnType<AuthAccountRepository["createCustomer"]>>;
      token: ReturnType<AccessTokenIssuer["issue"]>;
    };

export const createRegisterCustomer = (dependencies: {
  accounts: AuthAccountRepository;
  otps: OtpRepository;
  passwordHasher: PasswordHasher;
  tokens: AccessTokenIssuer;
}) => async (input: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  company?: unknown;
  password?: unknown;
}): Promise<RegisterResult> => {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!name || !email || !password) return { kind: "validation" };
  if (password.length < 6) return { kind: "invalid_password" };
  if (!await dependencies.otps.hasVerified(email, "signup")) return { kind: "unverified" };
  if (await dependencies.accounts.emailExists(email)) return { kind: "email_conflict" };

  const user = await dependencies.accounts.createCustomer({
    name,
    email,
    phone: typeof input.phone === "string" ? input.phone : undefined,
    company: typeof input.company === "string" ? input.company : undefined,
    passwordHash: await dependencies.passwordHasher.hash(password),
  });
  await dependencies.otps.consumeVerified(email, "signup");
  return {
    kind: "created",
    user,
    token: dependencies.tokens.issue({ userId: user.id, email: user.email, role: "customer", ...(user.organizationId ? { organizationId: user.organizationId } : {}) }),
  };
};

type ResetResult =
  | { kind: "validation" }
  | { kind: "invalid_password" }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "reset" };

export const createResetPassword = (dependencies: {
  accounts: AuthAccountRepository;
  otps: OtpRepository;
  passwordHasher: PasswordHasher;
}) => async (input: { email?: unknown; newPassword?: unknown }): Promise<ResetResult> => {
  const email = typeof input.email === "string" ? input.email.toLowerCase().trim() : "";
  const password = typeof input.newPassword === "string" ? input.newPassword : "";
  if (!email || !password) return { kind: "validation" };
  if (password.length < 6) return { kind: "invalid_password" };
  if (!await dependencies.otps.hasVerified(email, "forgot-password")) {
    return { kind: "unauthorized" };
  }
  if (!await dependencies.accounts.emailExists(email)) return { kind: "not_found" };
  const updated = await dependencies.accounts.replacePassword(
    email,
    await dependencies.passwordHasher.hash(password),
  );
  if (!updated) return { kind: "not_found" };
  await dependencies.otps.consumeVerified(email, "forgot-password");
  return { kind: "reset" };
};
