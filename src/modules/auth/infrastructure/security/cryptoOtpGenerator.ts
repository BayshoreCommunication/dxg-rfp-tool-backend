import { randomInt } from "crypto";
import type { OtpGenerator } from "../../domain/ports/otpPorts";

export const cryptoOtpGenerator: OtpGenerator = {
  generate() {
    return String(randomInt(100000, 1000000));
  },
};
