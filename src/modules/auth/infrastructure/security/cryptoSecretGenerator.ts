import { randomBytes } from "crypto";
import type { RandomSecretGenerator } from "../../domain/ports/googleIdentityPorts";

export const cryptoSecretGenerator: RandomSecretGenerator = {
  generate() {
    return randomBytes(32).toString("hex");
  },
};
