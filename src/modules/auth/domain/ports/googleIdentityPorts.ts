import type { SafeAuthUser } from "./authAccountPorts";

export type VerifiedGoogleIdentity = {
  subject: string;
  email: string;
  name?: string;
  avatar?: string;
};

export interface GoogleIdentityVerifier {
  verify(idToken: string): Promise<VerifiedGoogleIdentity>;
}

export interface RandomSecretGenerator {
  generate(): string;
}

export interface GoogleAccountRepository {
  findAndLinkExisting(identity: VerifiedGoogleIdentity): Promise<{
    user: SafeAuthUser;
    isBlocked: boolean;
  } | null>;
  createGoogleAccount(input: {
    identity: VerifiedGoogleIdentity;
    fallbackPasswordHash: string;
  }): Promise<SafeAuthUser>;
}
