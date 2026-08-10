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
import { safeLog } from "../../shared/observability/safeTelemetry";
import { ensureIdentityProjection } from "../dataFoundation/composition";
import { REFRESH_TOKEN_EXPIRY_MS } from "../../../config/jwt";

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
  refreshTokenTtlMs: REFRESH_TOKEN_EXPIRY_MS,
});

/* Every governed AI table in PostgreSQL is keyed off an rfpilot.users row that
   MongoDB signup does not create, so without this an account authenticates
   fine and then gets 503 ASSISTANT_ACTOR_NOT_READY from the assistant, the
   proposal draft, guidance and every other AI surface. Projecting on session
   establishment rather than at signup also repairs accounts created before
   this existed, on their next sign-in, with no backfill run.

   A projection failure must never block authentication: the AI modules already
   fail closed on a missing row, and the next sign-in retries. */
const provisionIdentityProjection = async (input: {
  userId: string;
  organizationId: string;
  correlationId: string;
}) => {
  const outcome = await ensureIdentityProjection({
    organizationMongoId: input.organizationId,
    userMongoId: input.userId,
    correlationId: input.correlationId,
  });
  if (outcome.kind === "ensured") {
    if (outcome.userCreated || outcome.organizationCreated) {
      safeLog("info", "identity.projection.created", {
        correlationId: input.correlationId,
        outcome: "success",
      });
    }
    return;
  }
  if (outcome.kind === "skipped") return;
  const errorCode = outcome.kind === "failed" ? outcome.code : "INVALID_EXTERNAL_ID";
  safeLog("error", "identity.projection.failed", {
    correlationId: input.correlationId,
    errorCode,
    outcome: "failure",
  });
  /* safeLog is inert unless OBSERVABILITY_ENABLED, and this failure silently
     disables every AI feature for the account, so it also goes to stdout.
     Code and correlation id only — never the identifiers themselves. */
  console.error(
    `identity.projection.failed code=${errorCode} correlationId=${input.correlationId}`,
  );
};

export const beginAuthenticatedSession = async (input: {
  userId: string;
  organizationId: string;
  correlationId: string;
  userAgent?: string;
  ip?: string;
}) => {
  const account = await mongoSessionAccountLoader.load(input.userId, input.organizationId);
  if (!account) throw new Error("Active organization membership is required");
  await provisionIdentityProjection(input);
  return authenticationSessions.begin({ account, ...input });
};
