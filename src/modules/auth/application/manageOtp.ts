import type {
  AuthUserLookup,
  Clock,
  OtpDelivery,
  OtpGenerator,
  OtpPurpose,
  OtpRepository,
} from "../domain/ports/otpPorts";

type RequestOtpResult =
  | { kind: "sent" }
  | { kind: "account_exists" }
  | { kind: "concealed_missing" };

export const createRequestOtp = (dependencies: {
  users: AuthUserLookup;
  otps: OtpRepository;
  delivery: OtpDelivery;
  generator: OtpGenerator;
}) => async (email: string, purpose: OtpPurpose): Promise<RequestOtpResult> => {
  const exists = await dependencies.users.emailExists(email);
  if (purpose === "signup" && exists) return { kind: "account_exists" };
  if (purpose === "forgot-password" && !exists) return { kind: "concealed_missing" };

  const code = dependencies.generator.generate();
  await dependencies.otps.replace(email, purpose, code);
  try {
    await dependencies.delivery.send(email, code, purpose);
  } catch (error) {
    await dependencies.otps.deleteFor(email, purpose);
    throw error;
  }
  return { kind: "sent" };
};

type VerifyOtpResult =
  | { kind: "verified" }
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "invalid" };

export const createVerifyOtp = (
  repository: OtpRepository,
  clock: Clock,
) => async (email: string, code: string, purpose: OtpPurpose): Promise<VerifyOtpResult> => {
  const challenge = await repository.findPending(email, purpose);
  if (!challenge) return { kind: "not_found" };
  if (clock.now().getTime() > challenge.expiresAt.getTime()) {
    await repository.deleteById(challenge.id);
    return { kind: "expired" };
  }
  if (challenge.code !== code.trim()) return { kind: "invalid" };
  await repository.markVerified(challenge.id);
  return { kind: "verified" };
};
