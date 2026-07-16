import User from "../../../../../modal/userModel";
import type { AuthUserLookup } from "../../domain/ports/otpPorts";

export const mongoAuthUserLookup: AuthUserLookup = {
  async emailExists(email) {
    return Boolean(await User.exists({ email }));
  },
};
