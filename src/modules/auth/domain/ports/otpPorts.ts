export type OtpPurpose = "signup" | "forgot-password";

export type OtpChallenge = {
  id: string;
  codeHash?: string;
  code?: string;
  expiresAt: Date;
  attempts?: number;
  maxAttempts?: number;
};

export interface OtpRepository {
  replace(email: string, purpose: OtpPurpose, codeHash: string): Promise<void>;
  findPending(email: string, purpose: OtpPurpose): Promise<OtpChallenge | null>;
  markVerified(id: string): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteFor(email: string, purpose: OtpPurpose): Promise<void>;
  hasVerified(email: string, purpose: OtpPurpose): Promise<boolean>;
  consumeVerified(email: string, purpose: OtpPurpose): Promise<void>;
  recordFailedAttempt?(id: string, maxAttempts: number): Promise<number>;
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

export interface OtpCodeHasher {
  hash(code: string): string;
  matches(code: string, codeHash: string): boolean;
}

export interface Clock {
  now(): Date;
}
