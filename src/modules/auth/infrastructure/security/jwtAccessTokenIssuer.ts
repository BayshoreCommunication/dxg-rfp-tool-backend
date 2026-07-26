import { generateAccessToken } from "../../../../../config/jwt";
import type { AccessTokenIssuer } from "../../domain/ports/authAccountPorts";

export const jwtAccessTokenIssuer: AccessTokenIssuer = {
  issue(input) {
    return generateAccessToken({
      userId: input.userId,
      email: input.email,
      role: input.role,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    });
  },
};
