import bcrypt from "bcryptjs";
import type { PasswordHasher, PasswordVerifier } from "./passwordHasher";

export const bcryptPasswordHasher: PasswordHasher = {
  async hash(password) {
    return bcrypt.hash(password, await bcrypt.genSalt(10));
  },
};

export const bcryptPasswordVerifier: PasswordVerifier = {
  async verify(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  },
};
