import {
  sendForgotPasswordOtpEmail,
  sendSignupOtpEmail,
} from "../../../../../utils/emailService";
import type { OtpDelivery } from "../../domain/ports/otpPorts";

export const legacyOtpDelivery: OtpDelivery = {
  async send(email, code, purpose) {
    if (purpose === "signup") await sendSignupOtpEmail(email, code);
    else await sendForgotPasswordOtpEmail(email, code);
  },
};
