export interface PasswordHasher {
  hash(password: string): Promise<string>;
}

export interface PasswordVerifier {
  verify(password: string, passwordHash: string): Promise<boolean>;
}
