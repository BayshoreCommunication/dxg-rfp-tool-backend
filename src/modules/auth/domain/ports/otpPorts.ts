export type OtpPurpose = "signup" | "forgot-password";

export type OtpChallenge = {
  id: string;
  code: string;
  expiresAt: Date;
};

export interface OtpRepository {
  replace(email: string, purpose: OtpPurpose, code: string): Promise<void>;
  findPending(email: string, purpose: OtpPurpose): Promise<OtpChallenge | null>;
  markVerified(id: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteFor(email: string, purpose: OtpPurpose): Promise<void>;
  hasVerified(email: string, purpose: OtpPurpose): Promise<boolean>;
  consumeVerified(email: string, purpose: OtpPurpose): Promise<void>;
}

export interface AuthUserLookup {
  emailExists(email: string): Promise<boolean>;
}

export interface OtpDelivery {
  send(email: string, code: string, purpose: OtpPurpose): Promise<void>;
}

export interface OtpGenerator {
  generate(): string;
}

export interface Clock {
  now(): Date;
}
