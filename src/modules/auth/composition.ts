import { createRequestOtp, createVerifyOtp } from "./application/manageOtp";
import { createRegisterCustomer, createResetPassword } from "./application/registerAndReset";
import {
  createAuthenticateCredentials,
  createGetAuthenticatedUser,
  createRegisterAdmin,
} from "./application/credentialAuthentication";
import { createAuthenticateGoogleIdentity } from "./application/googleAuthentication";
import { legacyOtpDelivery } from "./infrastructure/delivery/legacyOtpDelivery";
import { mongoAuthUserLookup } from "./infrastructure/mongo/mongoAuthUserLookup";
import { mongoAuthAccountRepository } from "./infrastructure/mongo/mongoAuthAccountRepository";
import { mongoOtpRepository } from "./infrastructure/mongo/mongoOtpRepository";
import { mongoGoogleAccountRepository } from "./infrastructure/mongo/mongoGoogleAccountRepository";
import { cryptoOtpGenerator } from "./infrastructure/security/cryptoOtpGenerator";
import { jwtAccessTokenIssuer } from "./infrastructure/security/jwtAccessTokenIssuer";
import { cryptoSecretGenerator } from "./infrastructure/security/cryptoSecretGenerator";
import { googleIdTokenVerifier } from "./infrastructure/identity/googleIdTokenVerifier";
import { createSessionManager } from "./application/manageSessions";
import { mongoRefreshSessionRepository } from "./infrastructure/mongo/mongoRefreshSessionRepository";
import { mongoSessionAccountLoader } from "./infrastructure/mongo/mongoSessionAccountLoader";
import { jwtSessionAccessTokenIssuer } from "./infrastructure/security/jwtSessionAccessTokenIssuer";
import { mongoSecurityAuditWriter } from "./infrastructure/audit/mongoSecurityAuditWriter";
import { hmacOtpCodeHasher } from "./infrastructure/security/hmacOtpCodeHasher";
import {
  bcryptPasswordHasher,
  bcryptPasswordVerifier,
} from "../../shared/security/bcryptPasswordHasher";

export const requestAuthenticationOtp = createRequestOtp({
  users: mongoAuthUserLookup,
  otps: mongoOtpRepository,
  delivery: legacyOtpDelivery,
  generator: cryptoOtpGenerator,
  hasher: hmacOtpCodeHasher,
});

export const verifyAuthenticationOtp = createVerifyOtp(mongoOtpRepository, {
  now: () => new Date(),
}, hmacOtpCodeHasher);

export const registerCustomerAccount = createRegisterCustomer({
  accounts: mongoAuthAccountRepository,
  otps: mongoOtpRepository,
  passwordHasher: bcryptPasswordHasher,
  tokens: jwtAccessTokenIssuer,
});

export const resetCustomerPassword = createResetPassword({
  accounts: mongoAuthAccountRepository,
  otps: mongoOtpRepository,
  passwordHasher: bcryptPasswordHasher,
});

export const authenticateWithCredentials = createAuthenticateCredentials({
  accounts: mongoAuthAccountRepository,
  passwords: bcryptPasswordVerifier,
  tokens: jwtAccessTokenIssuer,
});

export const registerAdminAccount = createRegisterAdmin({
  accounts: mongoAuthAccountRepository,
  passwords: bcryptPasswordHasher,
  tokens: jwtAccessTokenIssuer,
});

export const getAuthenticatedUserAccount = createGetAuthenticatedUser(
  mongoAuthAccountRepository,
);

export const authenticateGoogleIdentity = createAuthenticateGoogleIdentity({
  verifier: googleIdTokenVerifier,
  accounts: mongoGoogleAccountRepository,
  secrets: cryptoSecretGenerator,
  passwords: bcryptPasswordHasher,
  tokens: jwtAccessTokenIssuer,
});

export const authenticationSessions = createSessionManager({
  sessions: mongoRefreshSessionRepository,
  accounts: mongoSessionAccountLoader,
  accessTokens: jwtSessionAccessTokenIssuer,
  audit: mongoSecurityAuditWriter,
});

export const beginAuthenticatedSession = async (input: {
  userId: string;
  organizationId: string;
  correlationId: string;
  userAgent?: string;
  ip?: string;
}) => {
  const account = await mongoSessionAccountLoader.load(input.userId, input.organizationId);
  if (!account) throw new Error("Active organization membership is required");
  return authenticationSessions.begin({ account, ...input });
};
