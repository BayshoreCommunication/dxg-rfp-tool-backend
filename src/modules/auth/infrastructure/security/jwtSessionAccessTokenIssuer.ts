import { generateAccessToken } from "../../../../../config/jwt";
import type { SessionAccessTokenIssuer } from "../../domain/ports/sessionPorts";

export const jwtSessionAccessTokenIssuer: SessionAccessTokenIssuer = {
  issue(account, sessionId) {
    return generateAccessToken({
      userId: account.userId,
      email: account.email,
      role: account.role,
      organizationId: account.organizationId,
      sessionId,
      roles: account.roles,
      rolesVersion: account.rolesVersion,
    });
  },
};
