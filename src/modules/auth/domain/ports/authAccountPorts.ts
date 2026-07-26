export type SafeAuthUser = {
  id: string;
  organizationId?: string;
  name: string;
  email: string;
  role: string;
  phone?: string;
  company?: string;
  avatar?: string;
  createdAt?: Date;
};

export interface AuthAccountRepository {
  emailExists(email: string): Promise<boolean>;
  createCustomer(input: {
    name: string;
    email: string;
    phone?: string;
    company?: string;
    passwordHash: string;
  }): Promise<SafeAuthUser>;
  replacePassword(email: string, passwordHash: string): Promise<boolean>;
  findCredentials(email: string): Promise<{
    user: SafeAuthUser;
    passwordHash: string;
    isBlocked: boolean;
  } | null>;
  findSafeById(id: string): Promise<SafeAuthUser | null>;
  createAdmin(input: {
    name: string;
    email: string;
    phone?: string;
    passwordHash: string;
  }): Promise<SafeAuthUser>;
}

export type IssuedAccessToken = {
  accessToken: string;
  expiresAt: number;
  expiresIn: number;
};

export interface AccessTokenIssuer {
  issue(input: { userId: string; email: string; role: string; organizationId?: string }): IssuedAccessToken;
}
